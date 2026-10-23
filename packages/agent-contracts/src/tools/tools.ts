import type { ContentBlock } from "../conversation/messages.js";
import type { ToolFailureKind, ToolExecutionState, McpCallResultData, McpToolAnnotations, McpToolUiMetadata } from "./tool-data.js";
import type { PermissionMode, AgentPermissionDecision, AgentPermissionRequest } from "../policy/permissions.js";
import type { AgentExecutionContext } from "../execution/execution.js";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";

export interface ToolContext {
  cwd: string;
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
  /** Runtime-owned narrowing/restoration only; never changes the user-selected ceiling. */
  setPlanMode?: (enabled: boolean) => PermissionMode;
  /** Selected model identity for the request that invoked this tool. */
  requestConfiguration?: {
    model: string;
    provider?: string;
    apiFormat?: "anthropic" | "openai";
  };
  /** Actual tools available to the current QueryEngine after host injection and allow/deny filtering. */
  toolRegistry?: ToolRegistryView;
  /** Host-owned, Run-local discovery; supplied only to the trusted search tool. */
  toolDiscovery?: ToolDiscovery;
  /** Invoke an already captured tool through the same checked execution pipeline. */
  invokeTool?: (name: string, input: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<ToolResult>;
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

export interface MutableToolRegistry extends ToolRegistryView {
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
