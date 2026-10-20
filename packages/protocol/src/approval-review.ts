export interface ApprovalReviewResult {
  decision: "approve" | "ask_user" | "deny";
  risk: "low" | "medium" | "high" | "unknown";
  authorization: "explicit" | "task_implied" | "missing";
  reason: string;
}

/** Added by the host, never accepted from model JSON. */
export interface ApprovalReviewOutcome extends ApprovalReviewResult {
  failure?: "timeout" | "invalid_response" | "unavailable";
}

/** Only the host may construct this evidence from admitted inputs and tool registration. */
export interface ApprovalReviewEvidence {
  userInstruction: string;
  cwd: string;
  agentId?: string;
  accessBoundary: string;
  denyRules: readonly string[];
  reliableIsolation: boolean;
  context?: readonly { kind: "reference" | "tool_output"; content: string }[];
}

export interface ApprovalReviewInput {
  requestId: string;
  sessionId: string;
  runId?: string;
  inputId: string;
  runtimeRevision: number;
  tool: { name: string; source: string; description?: string };
  input: Record<string, unknown>;
  evidence: ApprovalReviewEvidence;
}

export interface ApprovalReviewRecord {
  status: "reviewing" | "approved" | "ask_user" | "denied" | "timed_out";
  startedAt: number;
  completedAt?: number;
  reason?: string;
  result?: ApprovalReviewResult;
}
