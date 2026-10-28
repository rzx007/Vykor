import { bindPreparedToolResults } from "./tool-results.js";
import {
  readonlyMap,
  type AgentEffects,
  type AgentEventInput,
  type AgentEventListener,
  type AgentEventSubscription,
  type AgentRunHandle,
  type AgentRunResult,
  type AgentRunPreparation,
  type AgentRunContribution,
  type AgentRunScope,
  type AgentExecutionContext,
  type AgentExecutionLimits,
  type AgentExecutionProfile,
  type ContentBlock,
  type Message,
  type RunToolBinding,
  type ToolUseBlock,
  type ToolExecutionResult,
  type ToolDescriptor,
  type AgentChildDirectory,
  type AgentChildSpawnInput,
  type AgentPostRunChildParent,
  type AgentChildInvocation,
  type AgentChildResult,
  type UsageSnapshot,
} from "@vykor/agent-contracts";
import type {
  IQueryEngine as QueryEngine,
  CompactContextProvider,
} from "@vykor/core/engine";
import {
  AgentOperationConflictError,
  type VykorAgentState,
} from "./agent-errors.js";
import { AgentEventBus } from "./event-source.js";
import { AgentChildManager } from "./children/child-agent.js";
import {
  FrameworkAgentRun,
  type FrameworkAgentRunToolActivity,
} from "./framework-agent-run.js";
export {
  AgentOperationConflictError,
  type VykorAgentState,
} from "./agent-errors.js";
export interface VykorAgentSubmitOptions {
  outputContract?: import("@vykor/agent-contracts").AgentOutputContract;
  preparation?: AgentRunPreparation;
  contribution?: AgentRunContribution;
  tools?: ReadonlyMap<string, RunToolBinding>;
  limits?: AgentExecutionLimits;
  profile?: AgentExecutionProfile;
  childRunParent?:
    | (Pick<AgentRunScope, "sessionId" | "runId" | "signal"> & {
        limits?: AgentExecutionLimits;
        bindToolDispatch?: import("@vykor/agent-contracts").ToolDispatchCheckFactory;
      })
    | null;
  signal?: AbortSignal;
  hardMaxTurns?: number;
  inputItems?: readonly unknown[];
  delivery?: "queue" | "steer";
  metadata?: Record<string, unknown>;
  ids?: {
    inputId: string;
    runId: string;
    traceId: string;
  };
}
export interface VykorAgentRunToolOptions {
  /** @deprecated Use PreparedAgentRun.bindToolResults; legacy stores remain trusted host capabilities. */
  toolResults?: import("@vykor/agent-contracts").RunToolResultStore;
  tools: ReadonlyMap<string, RunToolBinding>;
  scope: AgentRunScope;
  signal?: AbortSignal;
  confirmTool?: AgentExecutionContext["confirmTool"];
  onToolEvent?: (event: AgentEventInput) => Promise<void>;
}
export interface AgentCompactResult {
  history: Message[];
  beforeMessageCount: number;
  afterMessageCount: number;
}
export interface ModelVisibleTool extends ToolDescriptor {
  source: import("@vykor/agent-contracts").ToolRegistrationSource;
}
export interface ContextUsagePromptSource {
  systemPrompt?: string;
  memoryReminderText?: string;
}
export interface VykorAgent {
  readonly id: string;
  readonly state: VykorAgentState;
  readonly children: AgentChildDirectory;
  subscribe(listener: AgentEventListener): AgentEventSubscription;
  submitMessage(
    content: string | ContentBlock[],
    options?: VykorAgentSubmitOptions,
  ): AgentRunHandle;
  runMessage(
    content: string | ContentBlock[],
    options?: VykorAgentSubmitOptions,
  ): Promise<AgentRunResult>;
  runTool(
    toolUse: ToolUseBlock,
    options: VykorAgentRunToolOptions,
  ): Promise<ToolExecutionResult>;
  /** True only while no run, maintenance or retained descendant needs this instance. */
  canSuspend?(): boolean | Promise<boolean>;
  getHistory(): Message[];
  loadHistory(messages: Message[]): void;
  clear(): void;
  setCompactContextProvider(provider: CompactContextProvider | undefined): void;
  compact(): Promise<AgentCompactResult>;
  runChildForCompletedRun(
    input: AgentChildSpawnInput,
    parent: AgentPostRunChildParent,
    sensitiveInitialContent: string,
    tools?: ReadonlyMap<string, RunToolBinding>,
  ): Promise<{
    invocation: AgentChildInvocation;
    result: AgentChildResult;
  }>;
  getUsage(): UsageSnapshot;
  getContextUsagePromptSource(): ContextUsagePromptSource;
  close(): Promise<void>;
}
export interface KernelAgentOptions {
  outputContract?: import("@vykor/agent-contracts").AgentOutputContract;
  bindToolDispatch?: import("@vykor/agent-contracts").ToolDispatchCheckFactory;
  id: string;
  cwd: string;
  engine: QueryEngine;
  effects: AgentEffects;
  preparation: AgentRunPreparation;
  eventBus: AgentEventBus;
  childManager: AgentChildManager;
  childDirectory: AgentChildDirectory;
  identity?: {
    childId?: string;
    parentSessionId?: string;
    parentRunId?: string;
  };
  prepareClose?(): void | Promise<void>;
  release?(): void | Promise<void>;
  onSettled?(
    result: AgentRunResult | undefined,
    activity: FrameworkAgentRunToolActivity | undefined,
  ): void;
}
export class KernelAgent implements VykorAgent {
  readonly id: string;
  readonly children: AgentChildDirectory;
  private activeRun?: FrameworkAgentRun;
  private lifecycleState: VykorAgentState = "idle";
  private maintenance?: {
    settled: Promise<void>;
    controller?: AbortController;
  };
  private closePromise?: Promise<void>;
  constructor(private readonly options: KernelAgentOptions) {
    this.id = options.id;
    this.children = options.childDirectory;
  }
  get state(): VykorAgentState {
    return this.lifecycleState;
  }
  canSuspend(): boolean | Promise<boolean> {
    return this.lifecycleState === "idle" && !this.activeRun && !this.maintenance && !this.closePromise && this.options.childManager.list().length === 0;
  }
  subscribe(listener: AgentEventListener): AgentEventSubscription {
    return this.options.eventBus.subscribe(listener);
  }
  submitMessage(
    content: string | ContentBlock[],
    options: VykorAgentSubmitOptions = {},
  ): AgentRunHandle {
    this.assertIdle("submit a message");
    const random = () => globalThis.crypto.randomUUID();
    const ids = options.ids ?? {
      inputId: `input_${random()}`,
      runId: `run_${random()}`,
      traceId: random(),
    };
    const run = new FrameworkAgentRun({
      agentId: this.id,
      session: {
        id: this.id,
        getHistory: () => this.getHistory(),
        submitMessage: (content, input) =>
          this.options.engine.submitMessage(content, input),
      },
      engine: this.options.engine,
      preparation: options.preparation ?? this.options.preparation,
      bindToolDispatch: this.options.bindToolDispatch ?? options.childRunParent?.bindToolDispatch,
      outputContract: options.outputContract ?? this.options.outputContract,
      tools: options.tools,
      contribution: options.contribution,
      eventBus: this.options.eventBus,
      effects: this.options.effects,
      children: this.options.childManager,
      identity:
        options.childRunParent === undefined
          ? this.options.identity
          : {
              ...(this.options.identity?.childId
                ? { childId: this.options.identity.childId }
                : {}),
              ...(options.childRunParent
                ? {
                    parentSessionId: options.childRunParent.sessionId,
                    parentRunId: options.childRunParent.runId,
                  }
                : {}),
            },
      content,
      inputItems: options.inputItems,
      ids,
      externalSignal: options.signal,
      hardMaxTurns: options.hardMaxTurns,
      limits: options.limits,
      profile: options.profile,
      delivery: options.delivery ?? "queue",
      metadata: options.metadata,
      onSettled: (result, activity) => {
        try {
          this.options.onSettled?.(result, activity);
        } finally {
          if (this.activeRun === run) {
            this.activeRun = undefined;
            if (this.lifecycleState === "running") this.lifecycleState = "idle";
          }
        }
      },
    });
    this.activeRun = run;
    this.lifecycleState = "running";
    return run;
  }
  async runMessage(
    content: string | ContentBlock[],
    options?: VykorAgentSubmitOptions,
  ): Promise<AgentRunResult> {
    return await this.submitMessage(content, options).result;
  }
  async runTool(
    toolUse: ToolUseBlock,
    options: VykorAgentRunToolOptions,
  ): Promise<ToolExecutionResult> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      options.scope.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const scope = {
      ...options.scope,
      agentId: this.id,
      sessionId: this.id,
      cwd: this.options.cwd,
      signal,
    };
    const tools = readonlyMap(options.tools);
    return this.runMaintenance(
      "tool",
      async () => {
        const prepared = await this.options.preparation.prepare(scope);
        const bindToolDispatch = this.options.bindToolDispatch ?? prepared.run.bindToolDispatch;
        const invocations = new Set<Promise<void>>();
        try {
          const toolResults = await bindPreparedToolResults(prepared.run, tools, options.toolResults);
          signal.throwIfAborted();
          await options.onToolEvent?.({
            type: "tool.started",
            data: { toolUse },
          });
          let attempted = false;
          const deliver = async (result: ToolExecutionResult) => {
            if (attempted) return;
            attempted = true;
            await options.onToolEvent?.({
              type: "tool.completed",
              data: { toolUseId: toolUse.id, result },
            });
          };
          const result = await this.options.engine.executeTool(toolUse, {
            signal,
            onResult: deliver,
            execution: {
              scope,
              bindToolDispatch,
              checkToolDispatch: bindToolDispatch?.(scope, tools),
              toolResults,
              tools,
              confirmTool: options.confirmTool,
              effects: this.options.effects,
              children: this.options.childManager.createController({ ...scope, bindToolDispatch }, tools),
              emit: options.onToolEvent ?? (async () => {}),
              takeSteeredInputs: async () => [],
              closeSteering: () => {},
              observeInvocation: settled => {
                invocations.add(settled);
                void settled.finally(() => invocations.delete(settled)).catch(() => {});
              },
            },
          });
          if (!attempted) await deliver(result);
          return result;
        } finally {
          while (invocations.size) await Promise.allSettled([...invocations]);
          await prepared.release();
        }
      },
      controller,
    );
  }
  getHistory(): Message[] {
    return this.options.engine.getHistory();
  }
  loadHistory(messages: Message[]): void {
    this.assertIdle("load history");
    this.options.engine.loadMessages(messages);
  }
  clear(): void {
    this.assertIdle("clear history");
    this.options.engine.clear();
  }
  setCompactContextProvider(
    provider: CompactContextProvider | undefined,
  ): void {
    this.assertIdle("set compact context provider");
    this.options.engine.setCompactContextProvider(provider);
  }
  compact(): Promise<AgentCompactResult> {
    return this.runMaintenance("compact", async () => {
      const beforeMessageCount = this.getHistory().length;
      await this.options.engine.compact();
      const history = this.getHistory();
      return { history, beforeMessageCount, afterMessageCount: history.length };
    });
  }
  runChildForCompletedRun(
    input: AgentChildSpawnInput,
    parent: AgentPostRunChildParent,
    content: string,
    tools?: ReadonlyMap<string, RunToolBinding>,
  ): Promise<{
    invocation: AgentChildInvocation;
    result: AgentChildResult;
  }> {
    return this.runMaintenance("post_run_child", async () => {
      await parent.limits?.check("maintenance");
      const { childOutputContract, ...parentIdentity } = parent;
      const scope = {
        ...parentIdentity,
        agentId: this.id,
        sessionId: this.id,
        cwd: this.options.cwd,
        signal: parent.signal ?? new AbortController().signal,
      };
      const prepared = this.options.bindToolDispatch ? undefined : await this.options.preparation.prepare(scope);
      const bindToolDispatch = this.options.bindToolDispatch ?? prepared?.run.bindToolDispatch;
      try {
        const invocation = await this.options.childManager.spawnSystemChild(
          { ...scope, bindToolDispatch },
          input,
          content,
          tools,
          childOutputContract,
        );
        let result: AgentChildResult;
        try {
          result = await invocation.result;
        } finally {
          await this.options.childManager.close(
            invocation.id,
            "Post-run child finished",
          );
        }
        return { invocation, result };
      } finally { await prepared?.release?.(); }
    });
  }
  getUsage(): UsageSnapshot {
    return this.options.engine.getTotalUsage();
  }
  getContextUsagePromptSource(): ContextUsagePromptSource {
    return this.options.engine.getContextUsagePromptSource();
  }
  close(): Promise<void> {
    if (this.closePromise) {
      if (this.lifecycleState !== "closed") {
        if (this.activeRun?.cleanupUnconfirmed) void this.activeRun.interrupt("Agent closed").catch(() => {});
        // Keep the original close waiter; only signal retained child owners to
        // confirm a failed cleanup. Their original close promises remain canonical.
        for (const child of this.options.childManager.list()) {
          if (child.runId && child.readRun(child.runId).cleanupUnconfirmed) void child.close().catch(() => {});
        }
      }
      return this.closePromise;
    }
    this.lifecycleState = "closing";
    this.maintenance?.controller?.abort("Agent closed");
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        for (const cleanup of [
          () => this.activeRun?.interrupt("Agent closed"),
          () => this.maintenance?.settled,
          () => this.options.prepareClose?.(),
          () => this.options.childManager.closeAll(),
          () => this.options.release?.(),
          () => this.options.eventBus.drain(),
        ])
          try {
            await cleanup();
          } catch (error) {
            if (error instanceof AggregateError) failures.push(...error.errors);
            else failures.push(error);
          }
      } finally {
        this.lifecycleState = "closed";
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, `Agent cleanup failed: ${this.id}`);
    })();
    return this.closePromise;
  }
  private assertIdle(operation: string): void {
    if (this.lifecycleState !== "idle")
      throw new AgentOperationConflictError(
        this.id,
        this.lifecycleState,
        operation,
      );
  }
  runMaintenance<T>(
    operation: string,
    work: () => Promise<T>,
    controller?: AbortController,
  ): Promise<T> {
    this.assertIdle(operation);
    this.lifecycleState = "maintaining";
    let settle!: () => void;
    const maintenance = {
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      controller,
    };
    this.maintenance = maintenance;
    return (async () => {
      try {
        return await work();
      } finally {
        if (this.maintenance === maintenance) this.maintenance = undefined;
        if (this.lifecycleState === "maintaining") this.lifecycleState = "idle";
        settle();
      }
    })();
  }
}
