/** A definite result does not imply success or completion of the user's goal. */
export type ToolExecutionState = "not_started" | "completed" | "unknown";

export type ToolFailureKind =
  | "permission" | "policy" | "timeout" | "command" | "transport"
  | "provider" | "interrupted" | "unknown_outcome"
  | "invalid_input" | "precondition" | "authentication" | "configuration";
