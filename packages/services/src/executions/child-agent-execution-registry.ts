import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AwaitExecutionResult,
  ChildAgentExecution,
  ChildAgentExecutionListener,
  CompleteChildAgentExecutionInput,
  ExecutionStatus,
  RegisterChildAgentExecutionOptions,
} from "./types.js";
import { writeBoundedOutput } from "./bounded-output-file.js";

const MAX_OUTPUT_BYTES = 12_000;

interface ChildCallbacks {
  onInput(data: string): Promise<void>;
  onStop(): Promise<void>;
}

/**
 * Registry for framework-owned child Agent executions.
 *
 * This class never spawns or owns an operating-system process. The Agent
 * framework supplies input/stop callbacks and reports lifecycle completion.
 */
export class ChildAgentExecutionRegistry {
  private readonly executions = new Map<string, ChildAgentExecution>();
  private readonly callbacks = new Map<string, ChildCallbacks>();
  private readonly listeners = new Map<string, ChildAgentExecutionListener>();
  private idCounter = 0;

  constructor(private readonly outputDir?: string) {}

  registerChildExecution(options: RegisterChildAgentExecutionOptions): ChildAgentExecution {
    const id = options.id ?? `child_${++this.idCounter}`;
    if (this.executions.has(id)) throw new Error(`Child Agent execution already exists: ${id}`);
    const outputFile = this.outputDir ? join(this.outputDir, `${id}.log`) : undefined;
    if (outputFile) {
      mkdirSync(this.outputDir!, { recursive: true });
      writeFileSync(outputFile, "");
    }
    const execution: ChildAgentExecution = {
      id,
      backend: "child_agent",
      type: "agent",
      status: "running",
      description: options.description,
      cwd: options.cwd,
      sessionId: options.sessionId,
      prompt: options.prompt,
      ...(outputFile ? { outputFile } : {}),
      createdAt: Date.now(),
      startedAt: Date.now(),
      metadata: { child_session_id: options.childSessionId },
    };
    this.executions.set(id, execution);
    this.callbacks.set(id, { onInput: options.onInput, onStop: options.onStop });
    this.notify(execution, "created");
    return execution;
  }

  beginExecution(executionId: string): ChildAgentExecution {
    const execution = this.requireExecution(executionId);
    const reopening = execution.status !== "running";
    execution.status = "running";
    if (reopening) {
      execution.startedAt = Date.now();
      delete execution.finishedAt;
      delete execution.exitCode;
      if (execution.outputFile) writeFileSync(execution.outputFile, "");
    }
    this.notify(execution, "updated");
    return execution;
  }

  async completeExecution(
    executionId: string,
    input: CompleteChildAgentExecutionInput,
  ): Promise<ChildAgentExecution> {
    const execution = this.requireExecution(executionId);
    if (execution.outputFile) writeBoundedOutput(execution.outputFile, input.output);
    execution.status = input.status;
    execution.exitCode = input.status === "completed" ? 0 : 1;
    execution.finishedAt = Date.now();
    this.notify(execution, "completed");
    return execution;
  }

  getExecution(executionId: string): ChildAgentExecution | undefined {
    return this.executions.get(executionId);
  }

  /** Detach a closed child without discarding its completed output or wait result. */
  releaseChildExecution(executionId: string): void {
    this.callbacks.delete(executionId);
  }

  listExecutions(status?: string): ChildAgentExecution[] {
    const all = [...this.executions.values()].sort((a, b) => b.createdAt - a.createdAt);
    return status ? all.filter((execution) => execution.status === status) : all;
  }

  readOutput(executionId: string, maxBytes = MAX_OUTPUT_BYTES): string {
    const execution = this.requireExecution(executionId);
    if (!execution.outputFile || !existsSync(execution.outputFile)) return "(no output)";
    const content = readFileSync(execution.outputFile, "utf-8");
    return (content.length > maxBytes ? content.slice(-maxBytes) : content) || "(no output)";
  }

  async writeInput(executionId: string, data: string): Promise<void> {
    const execution = this.requireExecution(executionId);
    const callbacks = this.requireCallbacks(executionId);
    const previous = {
      status: execution.status,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      exitCode: execution.exitCode,
      output: execution.outputFile && existsSync(execution.outputFile)
        ? readFileSync(execution.outputFile, "utf-8")
        : undefined,
    };
    this.beginExecution(executionId);
    try {
      await callbacks.onInput(data);
    } catch (error) {
      if (execution.status === "running") {
        execution.status = previous.status;
        execution.startedAt = previous.startedAt;
        execution.finishedAt = previous.finishedAt;
        execution.exitCode = previous.exitCode;
        if (execution.outputFile && previous.output !== undefined) {
          writeBoundedOutput(execution.outputFile, previous.output);
        }
        this.notify(execution, "updated");
      }
      throw error;
    }
  }

  async stopExecution(executionId: string): Promise<ChildAgentExecution> {
    const execution = this.requireExecution(executionId);
    if (isTerminal(execution.status)) return execution;
    await this.requireCallbacks(executionId).onStop();
    execution.status = "stopped";
    execution.exitCode = 1;
    execution.finishedAt = Date.now();
    this.notify(execution, "completed");
    return execution;
  }

  awaitExecution(executionId: string, options?: { timeoutMs?: number }): Promise<AwaitExecutionResult> {
    const execution = this.requireExecution(executionId);
    if (isTerminal(execution.status)) return Promise.resolve(this.result(execution));

    return new Promise<AwaitExecutionResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unregister = () => {};
      const finish = (result: AwaitExecutionResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unregister();
        resolve(result);
      };
      unregister = this.registerExecutionListener((candidate, event) => {
        if (candidate.id === executionId && event === "completed") finish(this.result(candidate));
      });
      const current = this.requireExecution(executionId);
      if (isTerminal(current.status)) {
        finish(this.result(current));
        return;
      }
      if (options?.timeoutMs != null) {
        timer = setTimeout(() => {
          const latest = this.requireExecution(executionId);
          finish({ ...this.result(latest), timedOut: true });
        }, options.timeoutMs);
        timer.unref?.();
      }
    });
  }

  registerExecutionListener(listener: ChildAgentExecutionListener): () => void {
    const id = `child-listener_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.listeners.set(id, listener);
    return () => this.listeners.delete(id);
  }

  close(): void {
    this.listeners.clear();
    this.callbacks.clear();
  }

  private requireExecution(executionId: string): ChildAgentExecution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Child Agent execution not found: ${executionId}`);
    return execution;
  }

  private requireCallbacks(executionId: string): ChildCallbacks {
    const callbacks = this.callbacks.get(executionId);
    if (!callbacks) throw new Error(`Child Agent callbacks not found: ${executionId}`);
    return callbacks;
  }

  private result(execution: ChildAgentExecution): AwaitExecutionResult {
    return {
      status: execution.status,
      output: this.readOutput(execution.id),
      ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
    };
  }

  private notify(execution: ChildAgentExecution, event: "created" | "updated" | "completed"): void {
    const snapshot: ChildAgentExecution = { ...execution, metadata: { ...execution.metadata } };
    for (const listener of [...this.listeners.values()]) {
      try {
        const result = listener(snapshot, event);
        if (result && typeof result.then === "function") void result.catch(() => {});
      } catch {
        // One projection listener must not break the framework child lifecycle.
      }
    }
  }
}

function isTerminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}
