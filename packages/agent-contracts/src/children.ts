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
