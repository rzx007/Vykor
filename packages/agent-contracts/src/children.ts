import type { AgentExecutionLimits } from "./execution.js";
import type { ApprovalMode, WorkMode } from "./permissions.js";
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
const AGENT_CHILD_BUDGET_EXCEEDED_ERROR = Symbol.for("@vykor/agent-contracts/AgentChildBudgetExceededError");
export class AgentChildBudgetExceededError extends Error {
  private readonly [AGENT_CHILD_BUDGET_EXCEEDED_ERROR] = true;
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && AGENT_CHILD_BUDGET_EXCEEDED_ERROR in value && value[AGENT_CHILD_BUDGET_EXCEEDED_ERROR] === true;
  }

  constructor(
    readonly dimension: AgentChildBudgetDimension,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`Child agent budget exceeded for ${dimension}: current ${current}, limit ${limit}`);
    this.name = "AgentChildBudgetExceededError";
  }
}

/** Trusted non-completion sources; never inferred from free-form error text. */
export type ChildFailureKind =
  | "max_turns" | "timeout" | "user_cancelled" | "parent_interrupted"
  | "model_error" | "tool_error" | "unknown";

/** Durable, length-bounded evidence of unfinished child work. */
export interface ChildPartialResult {
  version: 1;
  childSessionId: string;
  runId: string;
  source: "committed_assistant_text" | "limit_finalization";
  text: string;
  truncated: boolean;
}

export interface AgentChildResult {
  status: "completed" | "failed" | "interrupted" | "stopped";
  output: string;
  error?: string;
  failureKind?: ChildFailureKind;
  partialResult?: ChildPartialResult;
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
  /** Host-derived constrained modes for durable child projection; never caller authorization. */
  approvalMode?: ApprovalMode;
  workMode?: WorkMode;
  allowedTools?: string[];
  requiredMcpServers?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  /** Caller-requested turn cap. At most it tightens the resolved role/configuration budget. */
  requestedMaxTurns?: number;
  timeoutSeconds?: number;
  /** Caller-requested wall-clock cap. At most it tightens the resolved role budget. */
  requestedTimeoutSeconds?: number;
  /** Task boundary the child owns. Task context only, never a permission or path allowlist. */
  scope?: string;
  /** Deliverable the parent expects back. Task context only, never a permission or path allowlist. */
  expectedResult?: string;
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

/** A bounded, sourced view of one child Run; never reasoning or raw tool payloads. */
export interface ChildActivitySnapshot {
  version: 1;
  runId: string;
  updatedAt: number;
  /** Latest committed user-visible assistant text, at most 2,000 characters. */
  latestAssistantText?: string;
  latestTool?: { name: string; status: "running" | "completed" | "failed"; at: number };
  toolCalls: number;
  modelTurns: number;
  usage?: { inputTokens?: number; outputTokens?: number; incomplete: boolean };
}

/** Trusted marker on an aborted child Run signal; the run copies its kind onto the terminal event. */
const CHILD_RUN_TERMINATION_ERROR = Symbol.for("@vykor/agent-contracts/ChildRunTerminationError");
export class ChildRunTerminationError extends Error {
  private readonly [CHILD_RUN_TERMINATION_ERROR] = true;
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && CHILD_RUN_TERMINATION_ERROR in value && value[CHILD_RUN_TERMINATION_ERROR] === true;
  }

  constructor(
    readonly failureKind: Extract<ChildFailureKind, "timeout" | "user_cancelled" | "parent_interrupted">,
    message: string,
  ) {
    super(message);
    this.name = "ChildRunTerminationError";
  }
}

export interface AgentInputReceipt {
  sessionId: string;
  inputId: string;
  runId: string;
}

const AGENT_RUN_NOT_ACCEPTING_INPUT_ERROR = Symbol.for("@vykor/agent-contracts/AgentRunNotAcceptingInputError");
export class AgentRunNotAcceptingInputError extends Error {
  private readonly [AGENT_RUN_NOT_ACCEPTING_INPUT_ERROR] = true;
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && AGENT_RUN_NOT_ACCEPTING_INPUT_ERROR in value && value[AGENT_RUN_NOT_ACCEPTING_INPUT_ERROR] === true;
  }

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

/**
 * Identity of one already-completed Root Run that a trusted post-run Child may
 * be attributed to. Callers cannot widen this into a forged session/agent/cwd.
 */
export interface AgentPostRunChildParent {
  limits?: AgentExecutionLimits;
  inputId: string;
  runId: string;
  traceId: string;
  signal?: AbortSignal;
}

export interface AgentSteerInput extends AgentChildInput {}

export interface AgentChildHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state: "starting" | "running" | "idle" | "suspended" | "closing" | "closed";
  readonly result: Promise<AgentChildResult>;
  /** Read-only bounded activity of the current Run; undefined without observed events. */
  readonly activity?: ChildActivitySnapshot;
  /** Host-owned current Run selection, separate from user input and metadata. */
  send(input: AgentChildInput): Promise<AgentInputReceipt>;
  interrupt(reason?: string): Promise<void>;
  /** Interrupts only the matching current Run, leaving the child available for reuse. */
  interruptRun(expectedRunId: string, reason?: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface AgentChildDirectory {
  get(childId: string): AgentChildHandle | undefined;
  getBySessionId(sessionId: string): AgentChildHandle | undefined;
  list(): AgentChildHandle[];
}
