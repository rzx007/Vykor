import type { Message, ToolUseBlock } from "../conversation/messages.js";
import type { AgentChildController, AgentChildInput, AgentInputReceipt, AgentRunScope, AgentSteerInput } from "./children.js";
import type { AgentEventInput } from "./events.js";
import type { AgentPermissionDecision, AgentPermissionRequest } from "../policy/permissions.js";

export interface AgentExecutionLimits {
  check(boundary: "run" | "model" | "tool" | "child" | "maintenance",
    tool?: { toolName: string; toolAttemptId: string }): void | Promise<void>;
  /** Host restrictions rebound to a framework-generated child Run, never model input. */
  forChildRun?(runId: string): AgentExecutionLimits;
}

/** Host-owned restrictions scoped to one Run, including every model retry. */
export interface AgentExecutionProfile {
  /** Host-selected bounded result references for captured tool calls. */
  readonly toolResultReferences?: boolean;
  maxOutputTokens?: number;
  executableHooks?: boolean;
}

const AGENT_EXECUTION_LIMIT_ERROR = Symbol.for("@vykor/core/AgentExecutionLimitError");

export function isAgentExecutionLimitError(value: unknown): value is AgentExecutionLimitError {
  return value instanceof AgentExecutionLimitError;
}

export class AgentExecutionLimitError extends Error {
  private readonly [AGENT_EXECUTION_LIMIT_ERROR] = true;
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null
      && AGENT_EXECUTION_LIMIT_ERROR in value && (value as unknown as AgentExecutionLimitError)[AGENT_EXECUTION_LIMIT_ERROR] === true;
  }
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionLimitError";
  }
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
  askUserPrompt?(question: string, context: AgentEffectContext): Promise<string>;
}

export interface AgentRunToolContribution {
  /** Trusted finalization tools may require a batch with no sibling effects. */
  readonly requiresSoloBatch?: true;
  /** Trusted host validation after authorization and before taking dispatch rights. */
  readonly beforeDispatch?: (input: Record<string, unknown>, context: import("../tools/tools.js").ToolContext) => Promise<string | undefined>;
  readonly definition: import("../tools/tools.js").ToolDefinition;
  readonly permission: "host-internal";
  /** End only after this exact definition succeeds and the whole batch is delivered. */
  readonly endRunOnSuccess?: true;
}

export interface AgentRunContribution {
  readonly systemGuidance?: string;
  readonly tools?: readonly AgentRunToolContribution[];
  /** Include actual tool result IDs as model-visible reference data. */
  readonly exposeToolResultIds?: true;
}

/** Objects captured from the host's already-filtered runtime for one Run. */
export interface RunToolBinding {
  /** Opaque identity of the original registered definition; omitted by JSON serialization. */
  readonly definitionIdentity?: symbol;
  readonly definition: import("../tools/tools.js").ToolDefinition;
  readonly source?: import("../tools/tools.js").ToolRegistrationSource;
  readonly invoke: import("../tools/tools.js").ToolDefinition["execute"];
}

/** Framework-internal execution capabilities shared with tool packages. */
export interface AgentExecutionContext {
  readonly toolResults?: import("../tools/result-data.js").RunToolResultStore;
  readonly toolSafety?: import("../tools/operations.js").AgentToolSafety;
  readonly limits?: AgentExecutionLimits;
  readonly modelAttempts?: ModelAttemptGate;
  readonly profile?: AgentExecutionProfile;
  readonly scope: AgentRunScope;
  readonly tools?: ReadonlyMap<string, RunToolBinding>;
  /** Optional host proof, consulted only after the ordinary checker returns ask. */
  readonly confirmTool?: (input: { toolUse: ToolUseBlock; binding: RunToolBinding; scope: AgentRunScope }) => Promise<boolean>;
  /** Trusted, run-scoped ceiling for this Run only. Later configuration cannot raise it. */
  readonly hardMaxTurns?: number;
  /** Trusted, run-scoped capabilities supplied by the host. */
  readonly contribution?: AgentRunContribution;
  readonly effects: AgentEffects;
  readonly children: AgentChildController;
  emit(event: AgentEventInput): Promise<void>;
  takeSteeredInputs(options?: { closeIfEmpty?: boolean }): Promise<AgentChildInput[]>;
  closeSteering(): void;
}

export interface AgentRunResult {
  delivery?: import("./delivery.js").DeliveryReceipt;
  status: "completed";
  output: string;
  history: Message[];
  usage: import("../model/usage.js").UsageSnapshot;
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


export interface PreparedAgentRun {
  /** Called after the framework fixes the final Run tool ceiling; never exposed to tools. */
  readonly bindToolResults?: (tools: ReadonlyMap<string, RunToolBinding>) => import("../tools/result-data.js").RunToolResultStore | Promise<import("../tools/result-data.js").RunToolResultStore>;
  /** Prebound stores stay usable only while final tool bindings remain equivalent to this preparation. */
  readonly toolResults?: import("../tools/result-data.js").RunToolResultStore;
  readonly toolSafety?: import("../tools/operations.js").AgentToolSafety;
  readonly tools: ReadonlyMap<string, RunToolBinding>;
  readonly contribution?: AgentRunContribution;
  readonly limits?: AgentExecutionLimits;
  readonly profile?: AgentExecutionProfile;
  readonly modelAttempts?: ModelAttemptGate;
}

export interface AgentRunPreparation {
  prepare(scope: AgentRunScope): Promise<{ run: PreparedAgentRun; release(): void | Promise<void> }>;
}

export interface ModelAttemptIdentity {
  scope: AgentRunScope;
  generationId: string;
  attempt: number;
}

export interface ModelAttemptAdmission extends ModelAttemptIdentity {
  model: string;
  provider?: string;
  purpose: "generation" | "compaction" | "finalization" | "memory" | "plugin_selection";
}

export interface ModelAttemptSettlement extends ModelAttemptIdentity {
  status: "completed" | "failed" | "interrupted";
  usageStatus: "complete" | "partial" | "unknown";
  usage?: import("../model/usage.js").UsageSnapshot;
  notDispatched?: true;
}

/** Hosts admit actual dispatch and durably settle every admitted attempt. */
export interface ModelAttemptGate {
  beforeDispatch(input: ModelAttemptAdmission): Promise<void>;
  settle(input: ModelAttemptSettlement): Promise<void>;
}

export interface AgentModelConfiguration {
  model: string;
  provider?: string;
  apiFormat?: "anthropic" | "openai";
  effort?: string;
  maxTurns?: number;
}
