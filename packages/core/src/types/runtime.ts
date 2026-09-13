import type { StreamingMessageClient } from "./client";
import type { AgentBackgroundShellHost, McpAuthHost, ToolRegistry } from "./tools";
import type { PermissionChecker } from "./permissions";
import type { HookExecutor } from "./hooks";
import type { ContentBlock, Message } from "./messages";
import type { StreamEvent } from "./events";
import type { Settings } from "./settings";
import type { CompactContextProvider } from "../engine/compact-service";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";

export interface AgentPermissionRequest {
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface AgentPermissionDecision {
  status: "approved" | "denied" | "expired";
  decision?: "once" | "session";
  reason?: string;
}

export interface AgentScheduledTaskInput {
  name: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: "rrule" | "once";
  timezone: string;
  destination: "standalone" | "chat";
  sessionId?: string;
  projectPaths: string[];
  executionMode?: "local" | "worktree";
  model?: string;
  effort?: string;
  skillNames?: string[];
  pluginNames?: string[];
  permissionProfile?: {
    mode: "read_only" | "workspace_write" | "full_access";
    network?: boolean;
    allowedTools?: string[];
    deniedTools?: string[];
  };
  overlapPolicy?: "skip" | "queue";
  missedRunPolicy?: "skip" | "run_once";
  stopPolicy?: {
    runOnce?: boolean;
    maxRuns?: number;
    stopWhenCompleted?: boolean;
    expiresAt?: number;
  };
}

export interface AgentScheduledTask extends AgentScheduledTaskInput {
  id: string;
  status: "active" | "paused" | "completed";
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
}

export interface AgentScheduledRun {
  id: string;
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "needs_attention" | "skipped";
  summary?: string;
  error?: string;
  sessionId?: string;
  runId?: string;
}

export interface AgentScheduleEffects {
  create(input: AgentScheduledTaskInput): Promise<AgentScheduledTask>;
  update(
    id: string,
    patch: Partial<AgentScheduledTaskInput> & {
      status?: AgentScheduledTask["status"];
    },
  ): Promise<AgentScheduledTask>;
  remove(id: string): Promise<void>;
  list(): Promise<AgentScheduledTask[]>;
  trigger(id: string): Promise<AgentScheduledRun>;
  listRuns(taskId?: string): Promise<AgentScheduledRun[]>;
}

export interface AgentEffectContext {
  agentId: string;
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  childId?: string;
  signal: AbortSignal;
}

export interface AgentEffects {
  requestPermission(input: AgentPermissionRequest, context: AgentEffectContext): Promise<AgentPermissionDecision>;
}

export interface AgentChildSpawnInput {
  description: string;
  prompt: string;
  agent: string;
  team?: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  allowedTools?: string[];
  requiredMcpServers?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  effort?: string;
  isolate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentChildInput {
  content: string;
  /** Original host input, carried unchanged for durable projection, never parsed by the runtime. */
  inputItems?: readonly unknown[];
  id?: string;
  delivery?: "queue" | "steer";
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentChildResult {
  status: "completed" | "failed" | "interrupted" | "stopped";
  output: string;
  error?: string;
}

/** Limits shared by every descendant of one root agent. The root itself is depth 0. */
export interface AgentChildBudget {
  maxDepth: number;
  maxActiveChildren: number;
  maxTotalChildren: number;
}

export interface AgentChildBudgetSnapshot extends AgentChildBudget {
  activeChildren: number;
  totalChildren: number;
}

export type AgentChildBudgetDimension = "depth" | "activeChildren" | "totalChildren";

/** A child was rejected before its environment or worktree was allocated. */
export class AgentChildBudgetExceededError extends Error {
  constructor(
    readonly dimension: AgentChildBudgetDimension,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`Child agent budget exceeded for ${dimension}: current ${current}, limit ${limit}`);
    this.name = "AgentChildBudgetExceededError";
  }
}

export interface AgentInputReceipt {
  sessionId: string;
  inputId: string;
  runId: string;
}

export class AgentRunNotAcceptingInputError extends Error {
  constructor(readonly runId: string) {
    super(`Run is not accepting input: ${runId}`);
    this.name = "AgentRunNotAcceptingInputError";
  }
}

export interface AgentChildInvocation {
  id: string;
  sessionId: string;
  inputId?: string;
  runId?: string;
  result: Promise<AgentChildResult>;
  worktree?: { path: string; branch: string };
  notice?: string;
}

export interface AgentChildController {
  hasChildAgent(invocationId: string): boolean;
  spawnChildAgent(input: AgentChildSpawnInput): Promise<AgentChildInvocation>;
  sendChildInput(invocationId: string, input: AgentChildInput): Promise<AgentInputReceipt>;
  interruptChildAgent(invocationId: string, reason?: string): Promise<void>;
  awaitChildAgent(invocationId: string): Promise<AgentChildResult>;
}

export interface AgentRunScope {
  agentId: string;
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  signal: AbortSignal;
}

export interface AgentEventContext {
  agentId: string;
  sessionId: string;
  inputId?: string;
  runId?: string;
  traceId?: string;
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentSerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export type AgentEventInput =
  | {
      type: "input.accepted";
      data: {
        content: string | ContentBlock[];
        inputItems?: readonly unknown[];
        delivery: "queue" | "steer";
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "run.started"; data: Record<string, never> }
  | { type: "run.completed"; data: { output: string; stopReason?: string } }
  | {
      type: "run.failed";
      data: { error: AgentSerializedError; output?: string };
    }
  | {
      type: "run.interrupted";
      data: { error: AgentSerializedError; output?: string };
    }
  | {
      type: "output.text.delta";
      data: {
        delta: string;
        phase?: import("./messages").AssistantMessagePhase;
      };
    }
  | { type: "output.turn.completed"; data: { stopReason: string } }
  | {
      type: "tool.started";
      data: {
        toolUse: {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
      };
    }
  | {
      type: "tool.completed";
      data: {
        toolUseId: string;
        result: {
          content: ContentBlock[];
          isError?: boolean;
          failureKind?: import("./tools").ToolFailureKind;
          toolAttemptId?: string;
        };
      };
    }
  | { type: "usage.updated"; data: { usage: import("./usage").UsageSnapshot } }
  | {
      type: "domain.event";
      data: { name: string; payload?: Record<string, unknown> };
    }
  | {
      type: "permission.requested";
      data: { requestId: string; request: AgentPermissionRequest };
    }
  | {
      type: "permission.resolved";
      data: { requestId: string; decision: AgentPermissionDecision };
    }
  | {
      type: "child.created";
      data: {
        childId: string;
        sessionId: string;
        spawn: AgentChildSpawnInput;
        cwd: string;
        worktree?: { path: string; branch: string };
      };
    }
  | { type: "child.suspended"; data: { childId: string; sessionId: string } }
  | { type: "child.resumed"; data: { childId: string; sessionId: string } }
  | {
      type: "child.closed";
      data: { childId: string; sessionId: string; result: AgentChildResult };
    };

export type AgentEvent = AgentEventInput & {
  id: string;
  sequence: number;
  occurredAt: string;
  context: AgentEventContext;
};

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export type AgentEventSubscription = () => void;

export interface AgentEventSource {
  subscribe(listener: AgentEventListener): AgentEventSubscription;
}

export interface AgentRunToolContribution {
  readonly definition: import("./tools").ToolDefinition;
  readonly permission: "host-internal";
}

export interface AgentRunContribution {
  readonly systemGuidance?: string;
  readonly tools?: readonly AgentRunToolContribution[];
}

/** Objects captured from the host's already-filtered runtime for one Run. */
export interface RunToolBinding {
  readonly ownerPluginId?: string;
  readonly definition: import("./tools").ToolDefinition;
  readonly source?: import("./tools").ToolRegistrationSource;
  readonly serverId?: string;
  readonly invoke: import("./tools").ToolDefinition["execute"];
}

export interface RunSkillBinding {
  readonly ownerPluginId?: string;
  readonly path: string;
  readonly definition: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly path: string;
    readonly source?: "bundled" | "user" | "project" | "plugin";
    readonly metadata?: Record<string, unknown>;
    readonly userInvocable: boolean;
    readonly disableModelInvocation: boolean;
    readonly model?: string;
    readonly argumentHint?: string;
    readonly commandName?: string;
    readonly displayName?: string;
  };
}

export interface RunAgentBinding {
  readonly ownerPluginId?: string;
  readonly definition: {
    name: string;
    description: string;
    systemPrompt?: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: string;
    effort?: string | number;
    permissionMode?: string;
    maxTurns?: number;
    skills?: string[];
    mcpServers?: unknown[];
    hooks?: Record<string, unknown>;
    color?: string;
    background?: boolean;
    initialPrompt?: string;
    memory?: string;
    isolation?: string;
    omitClaudeMd?: boolean;
    criticalSystemReminder?: string;
    requiredMcpServers?: string[];
    filename?: string;
    baseDir?: string;
    source?: "builtin" | "user" | "plugin";
    subagentType?: string;
    permissions?: string[];
  };
}

export interface RunMcpServerBinding {
  readonly ownerPluginId?: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly definition: import("./settings").McpServerConfig;
}

export interface RunCapabilityView {
  readonly pluginId?: string;
  readonly tools: ReadonlyMap<string, RunToolBinding>;
  readonly skills: ReadonlyMap<string, RunSkillBinding>;
  readonly mcpServers: ReadonlyMap<string, RunMcpServerBinding>;
  readonly agents: ReadonlyMap<string, RunAgentBinding>;
}

/** Framework-internal execution capabilities shared with tool packages. */
export interface AgentExecutionContext {
  readonly scope: AgentRunScope;
  readonly capabilityView?: RunCapabilityView;
  /** Trusted, run-scoped capabilities supplied by the host. */
  readonly contribution?: AgentRunContribution;
  readonly effects: AgentEffects;
  readonly children: AgentChildController;
  emit(event: AgentEventInput): Promise<void>;
  takeSteeredInputs(options?: { closeIfEmpty?: boolean }): Promise<AgentChildInput[]>;
  closeSteering(): void;
}

export interface AgentSteerInput extends AgentChildInput {}

export interface AgentRunResult {
  status: "completed";
  output: string;
  history: Message[];
  usage: import("./usage").UsageSnapshot;
}

export interface AgentRunHandle {
  readonly id: string;
  readonly inputId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly started: Promise<AgentInputReceipt>;
  readonly result: Promise<AgentRunResult>;
  steer(input: AgentSteerInput): Promise<AgentInputReceipt>;
  interrupt(reason?: string): Promise<void>;
}

export interface AgentChildHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state: "starting" | "running" | "idle" | "suspended" | "closing" | "closed";
  readonly result: Promise<AgentChildResult>;
  /** Host-owned current Run selection, separate from user input and metadata. */
  send(input: AgentChildInput, authorization?: Pick<RunCapabilityView, "pluginId">): Promise<AgentInputReceipt>;
  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentChildDirectory {
  get(childId: string): AgentChildHandle | undefined;
  getBySessionId(sessionId: string): AgentChildHandle | undefined;
  list(): AgentChildHandle[];
}

export interface QueryEngine {
  submitMessage(
    content: string | ContentBlock[],
    options?: {
      signal?: AbortSignal;
      execution?: AgentExecutionContext;
    },
  ): AsyncIterable<StreamEvent>;
  getHistory(): Message[];
  getContextUsagePromptSource(): {
    systemPrompt?: string;
    memoryReminderText?: string;
  };
  compact(): Promise<void>;
  clear(): void;
  setSystemPrompt(prompt: string): void;
  setApiClient(client: StreamingMessageClient): void;
  setModel(model: string): void;
  setMaxTurns(max: number): void;
  loadMessages(messages: Message[]): void;
  getTotalUsage(): import("./usage").UsageSnapshot;
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void;
  setCompactContextProvider(fn: CompactContextProvider | undefined): void;
  setAllowedTools(tools: string[] | null): void;
  setSessionId(sessionId: string | undefined): void;
  setMcpManager(mgr: unknown): void;
  setMcpAuth(auth: McpAuthHost | undefined): void;
  setTerminal(terminal: AgentTerminalHost | undefined): void;
  setJobs(jobs: AgentJobHost | undefined): void;
  setBackgroundShell(backgroundShell: AgentBackgroundShellHost | undefined): void;
  setSchedules(schedules: AgentScheduleEffects | undefined): void;
}

export interface MemoryRetriever {
  (userInput: string): Promise<string | null> | string | null;
}

export interface QueryEngineOptions {
  /** Host-provided Run prompt. With a View, takes precedence over systemPrompt/setSystemPrompt(). */
  systemPromptForRun?: (view: RunCapabilityView) => Promise<string>;
  maxTurns?: number;
  /** Runtime working directory used for all tool execution in this engine. */
  cwd?: string;
  /** Runtime session id used to scope task/swarm ownership. */
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  /** Default 300000 ms; can also be set with OPENHARNESS_TOOL_TIMEOUT_MS. */
  toolTimeoutMs?: number;
  settings?: Settings;
  compactKeepRecent?: number;
  skillRegistry?: unknown;
  memoryRetriever?: MemoryRetriever;
  executionEnvironment?: import("@openharness/environment").ExecutionEnvironmentHandle;
  /** Optional per-run trajectory policy factory. False disables the default tracker. */
  trajectoryTrackerFactory?: false | (() => import("../engine/trajectory/tracker").TrajectoryTracker);
  compactProgressCallback?: import("../engine/compact-service").CompactProgressCallback;
}

export type RuntimeSandboxState = "off" | "active" | "degraded" | "unavailable";

export interface RuntimeSandboxStatus {
  state: RuntimeSandboxState;
  enabled: boolean;
  active: boolean;
  backend?: string;
  platform?: string;
  reason?: string;
  degraded?: boolean;
  networkMode?: string;
  dns?: string[];
  proxy?: "configured" | "not configured";
}

export class RuntimeBundle {
  private cleanupCallbacks: Array<() => Promise<void> | void> = [];
  private syncCleanupCallbacks: Array<() => void> = [];
  sandboxStatus?: RuntimeSandboxStatus;
  /** Factory installed by the runtime host; never reloads components from disk. */
  createRunCapabilityView?: (pluginId?: string) => RunCapabilityView;

  constructor(
    public settings: Settings,
    public apiClient: StreamingMessageClient,
    public toolRegistry: ToolRegistry,
    public permissionChecker: PermissionChecker,
    public hookExecutor: HookExecutor,
    public queryEngine: QueryEngine,
  ) {}

  switchApiClient(newClient: StreamingMessageClient): void {
    this.apiClient = newClient;
    this.queryEngine.setApiClient(newClient);
  }

  addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void {
    this.cleanupCallbacks.push(cleanup);
    if (cleanupSync) this.syncCleanupCallbacks.push(cleanupSync);
  }

  async close(): Promise<void> {
    const callbacks = this.cleanupCallbacks.splice(0).reverse();
    this.syncCleanupCallbacks = [];
    for (const cleanup of callbacks) {
      await cleanup();
    }
  }

  closeSync(): void {
    const callbacks = this.syncCleanupCallbacks.splice(0).reverse();
    this.cleanupCallbacks = [];
    for (const cleanup of callbacks) {
      cleanup();
    }
  }
}
