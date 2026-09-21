import { randomUUID } from "node:crypto";

import type {
  CompactContextProvider,
  AgentChildDirectory,
  AgentChildBudgetSnapshot,
  AgentEffects,
  AgentEventListener,
  AgentEventSubscription,
  AgentRunHandle,
  AgentRunResult,
  AgentSession,
  ContentBlock,
  HookDefinition,
  Message,
  McpRuntimeRegistry,
  RuntimeBundle,
  RunCapabilityView,
  Settings,
  ToolDescriptor,
  ToolRegistrationSource,
  UsageSnapshot,
} from "@openharness/core";
import type { McpConnection } from "@openharness/mcp";

import type { AgentIdentity } from "./agent-composition.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import {
  AgentOperationConflictError,
  type OpenHarnessAgentState,
} from "./agent-errors.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
import {
  toAgentCapabilitySnapshot,
  type AgentCapabilitySnapshot,
  type ResolvedAgentCapabilities,
} from "./capability-resolution.js";
import {
  AgentChildRegistry,
  type AgentChildManager,
} from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";
import type { OpenHarnessAgentExtension } from "./extensions.js";
import {
  FrameworkAgentRun,
  type FrameworkAgentRunToolActivity,
} from "./framework-agent-run.js";
import type {
  AgentMemoryRuntime,
  AgentRememberResult,
} from "./memory-runtime.js";

export {
  AgentOperationConflictError,
  type OpenHarnessAgentState,
} from "./agent-errors.js";

export interface OpenHarnessAgentOptions extends OpenHarnessAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Settings["mcpServers"];
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  /** Host-owned registry that coordinates OAuth-driven MCP Runtime reconnects. */
  mcpRuntimeRegistry?: McpRuntimeRegistry;
  /** Reliable ordered host sink. A rejection fails the active framework operation. */
  onEvent?: AgentEventListener;
  /** 逐项替换或关闭默认能力；未传的项目继续使用各自默认值。 */
  capabilityOverrides?: AgentCapabilityOverrides;
  /** 宿主交互副作用；未提供审批器时 ask 会安全拒绝。 */
  effects?: AgentEffectOverrides;
}

export interface OpenHarnessAgentSubmitOptions {
  capabilityView?: RunCapabilityView;
  goal?: { goalId: string; revision: number; objective?: string };
  signal?: AbortSignal;
  inputItems?: readonly unknown[];
  delivery?: "queue" | "steer";
  metadata?: Record<string, unknown>;
  ids?: {
    inputId: string;
    runId: string;
    traceId: string;
  };
}

export interface AgentCompactResult {
  history: Message[];
  beforeMessageCount: number;
  afterMessageCount: number;
}

export interface AgentInspection {
  model: string;
  tools: Array<{
    name: string;
    source: ToolRegistrationSource;
    overrides?: ToolRegistrationSource;
  }>;
  hooks: Array<Pick<HookDefinition, "id" | "event" | "type" | "enabled">>;
  mcpServers: Array<{
    name: string;
    status: string;
    toolCount: number;
    resourceCount: number;
    command?: string;
    error?: string;
  }>;
  sandbox?: NonNullable<RuntimeBundle["sandboxStatus"]>;
  childBudget: AgentChildBudgetSnapshot;
  capabilities: AgentCapabilitySnapshot;
}

/** Model-visible tool schema + registration source (same registry used for sends). */
export interface ModelVisibleTool extends ToolDescriptor {
  source: ToolRegistrationSource;
}

export interface ContextUsagePromptSource {
  systemPrompt?: string;
  memoryReminderText?: string;
}

export interface OpenHarnessAgent {
  readonly id: string;
  readonly state: OpenHarnessAgentState;
  readonly children: AgentChildDirectory;
  createRunCapabilityView(pluginId?: string): RunCapabilityView;
  /** Subscribe to ordered observations. Observer failures never fail agent execution. */
  subscribe(listener: AgentEventListener): AgentEventSubscription;
  submitMessage(
    content: string | ContentBlock[],
    options?: OpenHarnessAgentSubmitOptions,
  ): AgentRunHandle;
  runMessage(
    content: string | ContentBlock[],
    options?: OpenHarnessAgentSubmitOptions,
  ): Promise<AgentRunResult>;
  getHistory(): Message[];
  loadHistory(messages: Message[]): void;
  clear(): void;
  setModel(model: string): void;
  setCompactContextProvider(
    provider: CompactContextProvider | undefined,
  ): void;
  compact(): Promise<AgentCompactResult>;
  remember(): Promise<AgentRememberResult>;
  getUsage(): UsageSnapshot;
  getCapabilities(): AgentCapabilitySnapshot;
  inspect(): AgentInspection;
  /** Tools currently registered for model calls (schemas + registration source). */
  listModelVisibleTools(): ModelVisibleTool[];
  /** Prompt source owned by the runtime that performs model calls. */
  getContextUsagePromptSource?(): ContextUsagePromptSource;
  close(): Promise<void>;
}

class DefaultOpenHarnessAgent implements OpenHarnessAgent {
  private activeRun?: FrameworkAgentRun;
  private completedRunToolActivity?: FrameworkAgentRunToolActivity;
  private maintenance?: {
    kind: "compact" | "remember";
    settled: Promise<void>;
  };
  private lifecycleState: OpenHarnessAgentState = "idle";
  private closePromise?: Promise<void>;

  constructor(
    private readonly runtime: RuntimeBundle,
    private readonly session: AgentSession,
    private readonly mcpConnections: () => readonly McpConnection[],
    private readonly retainMcpConnectionsForRun: () => () => void,
    private readonly memory: AgentMemoryRuntime | undefined,
    private readonly eventBus: AgentEventBus,
    private readonly effects: AgentEffects,
    private readonly identity: AgentIdentity | undefined,
    private readonly childManager: AgentChildManager,
    private readonly closeOwnedCapabilities: () => Promise<void>,
    readonly children: AgentChildDirectory,
    private readonly capabilities: ResolvedAgentCapabilities,
    private model: string,
  ) {}

  get id(): string {
    return this.session.id;
  }

  get state(): OpenHarnessAgentState {
    return this.lifecycleState;
  }

  subscribe(listener: AgentEventListener): AgentEventSubscription {
    return this.eventBus.subscribe(listener);
  }

  submitMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): AgentRunHandle {
    this.assertIdle("submit a message");
    this.completedRunToolActivity = { toolUses: [], toolResults: [] };
    const ids = options.ids ?? {
      inputId: `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      traceId: randomUUID(),
    };
    const capabilityView = options.capabilityView ?? this.createRunCapabilityView();
    const releaseMcpConnections = this.retainMcpConnectionsForRun();
    const run = new FrameworkAgentRun({
      agentId: this.id,
      session: this.session,
      runtime: this.runtime,
      eventBus: this.eventBus,
      effects: this.effects,
      children: this.childManager,
      identity: this.identity,
      content,
      inputItems: options.inputItems,
      ids,
      externalSignal: options.signal,
      delivery: options.delivery ?? "queue",
      metadata: options.metadata,
      goal: options.goal,
      capabilityView,
      onSettled: (result, toolActivity) => {
        releaseMcpConnections();
        if (this.activeRun !== run) return;
        if (result && toolActivity)
          this.completedRunToolActivity = toolActivity;
        this.activeRun = undefined;
        if (this.lifecycleState === "running") this.lifecycleState = "idle";
      },
    });
    this.activeRun = run;
    this.lifecycleState = "running";
    return run;
  }

  createRunCapabilityView(pluginId?: string): RunCapabilityView {
    return this.runtime.createRunCapabilityView?.(pluginId)
      ?? createRunCapabilityView({ toolRegistry: this.runtime.toolRegistry }, pluginId);
  }

  async runMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): Promise<AgentRunResult> {
    return await this.submitMessage(content, options).result;
  }

  getHistory(): Message[] {
    return this.session.getHistory();
  }

  loadHistory(messages: Message[]): void {
    this.assertIdle("load history");
    this.runtime.queryEngine.loadMessages(messages);
    this.completedRunToolActivity = undefined;
  }

  clear(): void {
    this.assertIdle("clear history");
    this.session.clear();
    this.completedRunToolActivity = undefined;
  }

  setModel(model: string): void {
    this.assertIdle("set the model");
    this.model = model;
    this.runtime.queryEngine.setModel(model);
  }

  setCompactContextProvider(
    provider: CompactContextProvider | undefined,
  ): void {
    this.assertIdle("set compact context provider");
    this.runtime.queryEngine.setCompactContextProvider(provider);
  }

  compact(): Promise<AgentCompactResult> {
    return this.runMaintenance("compact", async () => {
      const beforeMessageCount = this.getHistory().length;
      await this.runtime.queryEngine.compact();
      const history = this.getHistory();
      return { history, beforeMessageCount, afterMessageCount: history.length };
    });
  }

  remember(): Promise<AgentRememberResult> {
    return this.runMaintenance("remember", async () => {
      if (!this.memory) {
        return {
          skipped: true,
          reason: "memory is disabled",
          writtenIds: [],
          titles: [],
        };
      }
      return await this.memory.remember(
        this.getHistory(),
        this.runtime.apiClient,
        this.model,
        this.completedRunToolActivity,
      );
    });
  }

  getUsage(): UsageSnapshot {
    return this.runtime.queryEngine.getTotalUsage();
  }

  getCapabilities(): AgentCapabilitySnapshot {
    return toAgentCapabilitySnapshot(this.capabilities);
  }

  inspect(): AgentInspection {
    return {
      model: this.model,
      tools: this.runtime.toolRegistry
        .getAll()
        .flatMap((tool) => {
          const inspection = this.runtime.toolRegistry.inspect(tool.name);
          return inspection ? [inspection] : [];
        }),
      hooks: (this.runtime.hookExecutor.getAll?.() ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled,
      })),
      mcpServers: this.mcpConnections().map(toMcpInspection),
      childBudget: this.childManager.getBudgetSnapshot(),
      capabilities: this.getCapabilities(),
      ...(this.runtime.sandboxStatus
        ? { sandbox: this.runtime.sandboxStatus }
        : {}),
    };
  }

  listModelVisibleTools(): ModelVisibleTool[] {
    return this.runtime.toolRegistry.getAll().map((tool) => {
      const inspection = this.runtime.toolRegistry.inspect(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.safeToRetry === undefined ? {} : { safeToRetry: tool.safeToRetry }),
        source: inspection?.source ?? { kind: "runtime" },
      };
    });
  }

  getContextUsagePromptSource(): ContextUsagePromptSource {
    return this.runtime.queryEngine.getContextUsagePromptSource();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.lifecycleState === "closed") return Promise.resolve();
    this.lifecycleState = "closing";
    const closing = (async () => {
      const failures: unknown[] = [];
      try {
        for (const cleanup of [
          () => this.activeRun?.interrupt("Agent closed") ?? Promise.resolve(),
          () => this.maintenance?.settled ?? Promise.resolve(),
          () => this.childManager.closeAll(),
          () => this.closeOwnedCapabilities(),
          () => this.eventBus.drain(),
          () => this.runtime.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      } finally {
        this.lifecycleState = "closed";
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, `Agent cleanup failed: ${this.id}`);
    })();
    this.closePromise = closing;
    return closing;
  }

  private assertIdle(operation: string): void {
    if (this.lifecycleState !== "idle") {
      throw new AgentOperationConflictError(
        this.id,
        this.lifecycleState,
        operation,
      );
    }
  }

  private runMaintenance<T>(
    kind: "compact" | "remember",
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertIdle(kind);
    this.lifecycleState = "maintaining";
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const operation = { kind, settled };
    this.maintenance = operation;
    return (async () => {
      try {
        return await work();
      } finally {
        if (this.maintenance === operation) this.maintenance = undefined;
        if (this.lifecycleState === "maintaining") this.lifecycleState = "idle";
        settle();
      }
    })();
  }
}

export interface AssembledAgentOptions {
  runtime: RuntimeBundle;
  session: AgentSession;
  mcpConnections: () => readonly McpConnection[];
  retainMcpConnectionsForRun?: () => () => void;
  memory: AgentMemoryRuntime | undefined;
  eventBus: AgentEventBus;
  effects: AgentEffects;
  identity: AgentIdentity | undefined;
  childManager: AgentChildManager;
  cleanup?: { close(): Promise<void> };
  childDirectory: AgentChildRegistry;
  capabilities: ResolvedAgentCapabilities;
  model: string;
}

/** Kernel 与默认 Node 组装共用的最后一步；这里只接收已经准备好的对象。 */
export function createAssembledAgent(
  options: AssembledAgentOptions,
): OpenHarnessAgent {
  return new DefaultOpenHarnessAgent(
    options.runtime,
    options.session,
    options.mcpConnections,
    options.retainMcpConnectionsForRun ?? (() => () => undefined),
    options.memory,
    options.eventBus,
    options.effects,
    options.identity,
    options.childManager,
    options.cleanup ? () => options.cleanup!.close() : async () => {},
    options.childDirectory,
    options.capabilities,
    options.model,
  );
}

function toMcpInspection(
  connection: McpConnection,
): AgentInspection["mcpServers"][number] {
  return {
    name: connection.name,
    status: connection.status,
    toolCount: connection.tools.length,
    resourceCount: connection.resources.length,
    command: connection.config.command
      ? `${connection.config.command} ${(connection.config.args ?? []).join(" ")}`.trim()
      : connection.config.url,
    ...(connection.error ? { error: connection.error.message } : {}),
  };
}
