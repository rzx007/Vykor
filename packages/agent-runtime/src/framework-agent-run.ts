import { randomUUID } from "node:crypto";

import type { AgentEffects, AgentEventContext, AgentEventInput, AgentExecutionContext, AgentInputReceipt, AgentRunHandle, AgentRunResult, AgentRunScope, AgentSteerInput, ContentBlock, StreamEvent } from "@vykor/core";
import { AgentRunNotAcceptingInputError, type AgentSession, type RuntimeBundle } from "@vykor/core";

import type { AgentChildManager } from "./child-agent.js";
import { abortError, serializeError } from "./agent-errors.js";
import { AgentEventDeliveryError, type AgentEventBus } from "./event-source.js";
import { createGoalRunContribution } from "./goal-extension.js";

interface FrameworkAgentRunOptions {
  capabilityView?: AgentExecutionContext["capabilityView"];
  goal?: { goalId: string; revision: number; objective?: string };
  agentId: string;
  session: AgentSession;
  runtime: RuntimeBundle;
  eventBus: AgentEventBus;
  effects: AgentEffects;
  children: AgentChildManager;
  identity?: {
    childId?: string;
    parentSessionId?: string;
    parentRunId?: string;
  };
  content: string | ContentBlock[];
  inputItems?: readonly unknown[];
  ids: { inputId: string; runId: string; traceId: string };
  externalSignal?: AbortSignal;
  delivery: "queue" | "steer";
  metadata?: Record<string, unknown>;
  onSettled(result: AgentRunResult | undefined, toolActivity: FrameworkAgentRunToolActivity | undefined): void;
}

export interface FrameworkAgentRunToolActivity {
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; isError: boolean | undefined }>;
}

interface PendingSteer {
  input: AgentSteerInput;
  receipt: ReturnType<typeof deferred<AgentInputReceipt>>;
}

/** 把 StreamEvent 里与文本/思考相关的事件映射成 AgentEvent；其余事件交给调用方。 */
export function streamEventToAgentEvent(event: StreamEvent): AgentEventInput | undefined {
  if (event.type === "text_delta") {
    return {
      type: "output.text.delta",
      data: {
        delta: event.delta,
        ...(event.phase ? { phase: event.phase } : {}),
      },
    };
  }
  if (event.type === "reasoning_delta") {
    return {
      type: "output.reasoning.delta",
      data: { delta: event.delta, source: event.source },
    };
  }
  return undefined;
}

export class FrameworkAgentRun implements AgentRunHandle {
  readonly id: string;
  readonly inputId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly started: Promise<AgentInputReceipt>;
  readonly result: Promise<AgentRunResult>;
  active = true;

  private readonly controller = new AbortController();
  private readonly steered: PendingSteer[] = [];
  private readonly pendingSteers = new Set<PendingSteer>();
  private readonly toolActivity: FrameworkAgentRunToolActivity = {
    toolUses: [],
    toolResults: [],
  };
  private readonly start = deferred<AgentInputReceipt>();
  private acceptingInput = true;
  private externalAbort?: () => void;

  constructor(private readonly options: FrameworkAgentRunOptions) {
    this.id = options.ids.runId;
    this.inputId = options.ids.inputId;
    this.sessionId = options.session.id;
    this.traceId = options.ids.traceId;
    this.started = this.start.promise;
    if (options.externalSignal) {
      this.externalAbort = () => this.controller.abort(options.externalSignal!.reason ?? "Run interrupted");
      if (options.externalSignal.aborted) this.externalAbort();
      else
        options.externalSignal.addEventListener("abort", this.externalAbort, {
          once: true,
        });
    }
    let completedResult: AgentRunResult | undefined;
    this.result = Promise.resolve()
      .then(() => this.execute())
      .then((result) => {
        completedResult = result;
        return result;
      })
      .finally(() => {
        this.active = false;
        this.acceptingInput = false;
        if (this.externalAbort && options.externalSignal) {
          options.externalSignal.removeEventListener("abort", this.externalAbort);
        }
        options.onSettled(completedResult, completedResult ? this.snapshotToolActivity() : undefined);
      });
    void this.started.catch(() => {});
    void this.result.catch(() => {});
  }

  async steer(input: AgentSteerInput): Promise<AgentInputReceipt> {
    if (!this.active || !this.acceptingInput) throw new AgentRunNotAcceptingInputError(this.id);
    const accepted = {
      ...input,
      id: input.id ?? `input_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
      delivery: "steer" as const,
    };
    const receipt = deferred<AgentInputReceipt>();
    void receipt.promise.catch(() => {});
    const pending = { input: accepted, receipt };
    this.steered.push(pending);
    this.pendingSteers.add(pending);
    return await receipt.promise;
  }

  async interrupt(reason?: string): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(reason ?? "Run interrupted");
    await this.result.catch(() => {});
  }

  private async execute(): Promise<AgentRunResult> {
    let output = "";
    let stopReason: string | undefined;
    const scope: AgentRunScope = {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      cwd: this.options.children.cwd,
      traceId: this.traceId,
      signal: this.controller.signal,
    };
    const execution: AgentExecutionContext = {
      scope,
      capabilityView: this.options.capabilityView,
      ...(this.options.goal ? { contribution: createGoalRunContribution(this.options.goal) } : {}),
      effects: this.options.effects,
      children: this.options.children.createController(scope, this.options.capabilityView),
      emit: (event) => this.emit(event),
      takeSteeredInputs: (options) => this.takeSteeredInputs(options),
      closeSteering: () => {
        this.acceptingInput = false;
      },
    };

    try {
      await this.emit({
        type: "input.accepted",
        data: {
          content: this.options.content,
          ...(this.options.inputItems ? { inputItems: this.options.inputItems } : {}),
          delivery: this.options.delivery,
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
        },
      });
      await this.emit({ type: "run.started", data: {} });
      this.start.resolve({
        sessionId: this.sessionId,
        inputId: this.inputId,
        runId: this.id,
      });
      for await (const event of this.options.session.submitMessage(this.options.content, {
        signal: this.controller.signal,
        execution,
      })) {
        if (this.controller.signal.aborted) throw abortError(this.controller.signal);
        if (event.type === "text_delta") output += event.delta;
        if (event.type === "complete") stopReason = event.stopReason;
        await this.projectStreamEvent(event);
      }
      if (this.controller.signal.aborted) throw abortError(this.controller.signal);
      this.acceptingInput = false;
      this.rejectPendingSteers();
      await this.emit({
        type: "run.completed",
        data: { output, ...(stopReason ? { stopReason } : {}) },
      });
      return {
        status: "completed",
        output,
        history: this.options.session.getHistory(),
        usage: this.options.runtime.queryEngine.getTotalUsage(),
      };
    } catch (error) {
      this.acceptingInput = false;
      this.rejectPendingSteers();
      this.start.reject(error);
      if (!(error instanceof AgentEventDeliveryError)) {
        const interrupted = this.controller.signal.aborted;
        await this.emit({
          type: interrupted ? "run.interrupted" : "run.failed",
          data: { error: serializeError(error), ...(output ? { output } : {}) },
        }).catch(() => {});
      }
      throw error;
    }
  }

  private async takeSteeredInputs(options: { closeIfEmpty?: boolean } = {}): Promise<AgentSteerInput[]> {
    const pending = this.steered.splice(0, 1);
    if (pending.length === 0 && options.closeIfEmpty) this.acceptingInput = false;
    const inputs: AgentSteerInput[] = [];
    try {
      for (const { input } of pending) {
        await this.emit(
          {
            type: "input.accepted",
            data: {
              content: input.content,
              ...(input.inputItems ? { inputItems: input.inputItems } : {}),
              delivery: "steer",
              ...(input.metadata ? { metadata: input.metadata } : {}),
            },
          },
          { inputId: input.id, traceId: input.traceId },
        );
        inputs.push(input);
      }
    } catch (error) {
      const rejected = new AgentRunNotAcceptingInputError(this.id);
      for (const item of pending) item.receipt.reject(rejected);
      throw error;
    } finally {
      for (const item of pending) this.pendingSteers.delete(item);
    }
    for (const { input, receipt } of pending) {
      receipt.resolve({
        sessionId: this.sessionId,
        inputId: input.id!,
        runId: this.id,
      });
    }
    return inputs;
  }

  private rejectPendingSteers(): void {
    const error = new AgentRunNotAcceptingInputError(this.id);
    for (const pending of this.pendingSteers) pending.receipt.reject(error);
    this.pendingSteers.clear();
    this.steered.splice(0);
  }

  private async projectStreamEvent(event: StreamEvent): Promise<void> {
    const mapped = streamEventToAgentEvent(event);
    if (mapped) {
      await this.emit(mapped);
      return;
    }
    if (event.type === "complete") {
      await this.emit({
        type: "output.turn.completed",
        data: { stopReason: event.stopReason },
      });
    } else if (event.type === "tool_use_start") {
      this.toolActivity.toolUses.push({
        id: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
      });
      await this.emit({
        type: "tool.started",
        data: { toolUse: event.toolUse },
      });
    } else if (event.type === "tool_use_end") {
      this.toolActivity.toolResults.push({
        toolUseId: event.toolUseId,
        isError: event.result.isError,
      });
      await this.emit({
        type: "tool.completed",
        data: { toolUseId: event.toolUseId, result: event.result },
      });
    } else if (event.type === "usage") {
      await this.emit({ type: "usage.updated", data: { usage: event.usage } });
    } else if (event.type === "error") {
      throw event.error;
    }
  }

  private snapshotToolActivity(): FrameworkAgentRunToolActivity {
    return {
      toolUses: this.toolActivity.toolUses.map((toolUse) => ({ ...toolUse })),
      toolResults: this.toolActivity.toolResults.map((toolResult) => ({
        ...toolResult,
      })),
    };
  }

  private async emit(event: AgentEventInput, override: Partial<AgentEventContext> = {}): Promise<void> {
    await this.options.eventBus.emit(event, {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      traceId: this.traceId,
      ...this.options.identity,
      ...override,
    });
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
