import type { ShellOutputLogHost } from "@vykor/agent-contracts";
import type { ToolFailureKind, ToolExecutionState } from "@vykor/agent-contracts";
import type { ContentBlock, Message, ToolUseBlock } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import type {
  AgentExecutionContext,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentScheduleEffects,
} from "./runtime";
import type { AgentTerminalHost } from "@vykor/terminal";
import type { AgentJobHost } from "@vykor/jobs";
import type { ExecutionEnvironmentHandle, ShellDescriptor } from "@vykor/environment";
import type { McpCallResultData, McpToolAnnotations, McpToolUiMetadata } from "@vykor/protocol";

export interface McpAuthConfigureInput {
  serverName: string;
  mode: "bearer" | "header" | "env";
  value: string;
  key?: string;
}

export interface McpAuthConfigureResult {
  message: string;
}

export interface McpAuthHost {
  configure(input: McpAuthConfigureInput): Promise<McpAuthConfigureResult>;
}

/** Host-owned creation boundary for detached shell jobs. */
export interface AgentBackgroundShellHost {
  create(input: {
    /** Stable identity for one logical creation request; retries must reuse it. */
    requestId: string;
    cwd: string;
    sessionId: string;
    command: string;
    description: string;
    /** Working directory inside the acquired execution environment. */
    executionCwd?: string;
    settings?: Settings;
    shellDescriptor?: ShellDescriptor;
  }): Promise<{
    jobId: string;
    label: string;
  }>;
}

export interface ToolContext {
  cwd: string;
  /** Complete frozen capability selection for the owning Run. */
  capabilityView?: import("./runtime").RunCapabilityView;
  /** Effective execution environment. Runtime-owned contexts always provide it. */
  environment?: ExecutionEnvironmentHandle;
  sessionId?: string;
  /** Stable model-issued tool call identity. Retries of the same call reuse this value. */
  toolCallId?: string;
  /** Identity of this concrete execution attempt. */
  toolAttemptId?: string;
  /** Current-Run, bounded actual results; never a persistent archive or model-provided body. */
  readToolResult?: (toolUseId: string) => ToolExecutionResult | undefined;
  /** Lifetime of the owning session run; use for detached work that outlives this tool call. */
  runAbortSignal?: AbortSignal;
  /** Lifetime of this tool invocation, including its execution timeout. */
  abortSignal?: AbortSignal;
  /** Absolute execution deadline (Unix milliseconds); bounded waits should return before it. */
  deadlineAt?: number;
  settings?: Settings;
  /** Runtime-owned narrowing/restoration only; never changes the user-selected ceiling. */
  setPlanMode?: (enabled: boolean) => import("@vykor/host-config").PermissionMode;
  /** Selected model identity for the request that invoked this tool. */
  requestConfiguration?: {
    model: string;
    provider?: string;
    apiFormat?: Settings["apiFormat"];
  };
  /** Actual tools available to the current QueryEngine after host injection and allow/deny filtering. */
  toolRegistry?: ToolRegistryView;
  /** Host-owned, Run-local discovery; supplied only to the trusted search tool. */
  toolDiscovery?: ToolDiscovery;
  /** MCP proxy only: invoke one captured MCP tool through ordinary authorization. */
  callMcpTool?: (
    name: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ) => Promise<ToolResult>;
  skillRegistry?: unknown;
  /** MCP 客户端管理器，供 ListMcpResources / ReadMcpResource 元工具使用。 */
  mcpManager?: unknown;
  /** Host-owned MCP auth updater. It saves config and reconnects the live MCP manager. */
  mcpAuth?: McpAuthHost;
  /** Host-owned persistent terminal capability. Omitted in runtimes without PTY support. */
  terminal?: AgentTerminalHost;
  /** Host-owned controller for all long-running work in the durable session. */
  jobs?: AgentJobHost;
  /** Host-owned creator for detached shell jobs. */
  backgroundShell?: AgentBackgroundShellHost;
  /** Host-managed bounded output from foreground Shell calls. */
  shellOutputLogs?: ShellOutputLogHost;
  /** Host-owned persistent scheduler. Omitted when durable schedules are unavailable. */
  schedules?: AgentScheduleEffects;
  /** Host-owned interactive user question. */
  askUserPrompt?: (question: string) => Promise<string>;
  /** Request a normal persisted Permission decision from the host. */
  requestPermission?: (
    request: AgentPermissionRequest,
  ) => Promise<AgentPermissionDecision>;
  agent?: AgentExecutionContext;
}

export interface ToolResult {
  content: ContentBlock[];
  /** Original bounded MCP response; private to the authorized application host. */
  mcpResult?: McpCallResultData;
  isError?: boolean;
  failureKind?: ToolFailureKind;
  executionState?: ToolExecutionState;
  recoveryHint?: string;
  /** Controlled builtin/host summary, at most 1,000 characters; never an instruction. */
  compactSummary?: string;
  /** Set only by checked execution after verifying the captured builtin definition. */
  hostFileFacts?: HostFileFacts;
  metadata?: Record<string, unknown>;
}

/** File observations emitted by a captured builtin; free metadata is not a trust boundary. */
export interface HostFileFacts {
  environmentKey: string;
  executionRoot?: string;
  pathStyle?: "windows" | "posix";
  files: Array<{
    path: string;
    subjectKey: string;
    operation: "read" | "write" | "edit" | "patch";
    beforeDigest?: "missing" | `sha256:${string}`;
    afterDigest: "missing" | `sha256:${string}`;
    completed: true;
    bodyVisible?: boolean;
  }>;
}

export interface ToolExecutionResult extends ToolResult {
  toolUseId: string;
  toolName: string;
  toolAttemptId?: string;
}

export interface ToolExecutionSpec {
  domain: "environment" | "control_plane";
  supportedEnvironments?: Array<"local" | "wsl">;
  /** Whether this control-plane tool needs outbound network access. */
  network?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Presentation hints, never authorization. */
  ui?: McpToolUiMetadata;
  annotations?: McpToolAnnotations;
  /** Resolve one parameter from a settled same-tool call before validation and authorization. */
  inputReuse?: {
    property: string;
    referenceProperty: string;
  };
  /** Automatic retry is forbidden unless this is explicitly true. */
  safeToRetry?: boolean;
  /** Calls in the same response and group authorize and execute in model order. */
  serialGroup?: string;
  /** Where this tool actually runs. Omission is fail-closed to local execution. */
  execution?: ToolExecutionSpec;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}

/** Immutable model-visible metadata; deliberately excludes execute(). */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly ui?: McpToolUiMetadata;
  readonly annotations?: McpToolAnnotations;
  readonly safeToRetry?: boolean;
  readonly execution?: ToolExecutionSpec;
}

export interface ToolRegistrationSource {
  readonly kind: "builtin" | "agent" | "extension" | "plugin" | "mcp" | "runtime";
  readonly id?: string;
}

/** Search metadata excludes schemas and execution handles; descriptions are untrusted data. */
export interface ToolDiscoveryEntry {
  readonly name: string;
  readonly description: string;
  readonly source?: ToolRegistrationSource;
}

export interface ToolDiscovery {
  readonly catalog: readonly ToolDiscoveryEntry[];
  getEligibleNames(): ReadonlySet<string>;
  /** Request schemas for the next model request; never changes Run authorization. */
  expose(names: readonly string[]): readonly string[];
}

export interface RegisteredToolInspection {
  name: string;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}

export interface ToolRegistryView {
  get(name: string): ToolDescriptor | undefined;
  getAll(): ToolDescriptor[];
  has(name: string): boolean;
  inspect(name: string): RegisteredToolInspection | undefined;
}

export interface ToolRegistry extends ToolRegistryView {
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  register(tool: ToolDefinition, source?: ToolRegistrationSource): void;
  override(tool: ToolDefinition, source: ToolRegistrationSource): void;
  /**
   * Atomically replace every tool registered by one exact source.
   *
   * Implementations must validate the whole replacement set before publishing
   * it, keep the method synchronous, and never call back into waiting code in
   * the middle of the swap. A failed validation leaves the registry untouched.
   */
  replaceBySource(source: ToolRegistrationSource, tools: ToolDefinition[]): void;
  unregister?(name: string): boolean;
}
