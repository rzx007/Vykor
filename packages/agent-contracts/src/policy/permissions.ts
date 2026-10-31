export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  reason?: string;
}

export interface ToolPermissionCheckContext {
  /** A concrete operation still needs confirmation in ordinary approval modes. */
  requireConfirmation?: boolean;
}

/** User-facing authorization presets, independent from read-only planning. */
export type ApprovalMode = "ask" | "auto_review" | "full_access";
export type WorkMode = "execute" | "plan";

export type PermissionMode = "default" | "plan" | "full_auto" | ApprovalMode;

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

export interface AgentPermissionRequest {
  toolName: string;
  /** Host-scoped concrete operation; never reuse or create a tool-wide session grant. */
  confirmation?: "once";
  /** Captured host registration; never supplied by the model. */
  toolSource?: string;
  toolDescription?: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface AgentPermissionDecision {
  status: "approved" | "denied" | "expired";
  decision?: "once" | "session";
  reason?: string;
  answer?: string;
}

export interface PermissionChecker {
  /** Runtime owners may expose their current mode; custom checkers need not. */
  getMode?(): PermissionMode;
  checkTool(
    toolName: string,
    input: Record<string, unknown>,
    /** Host-owned schema declarations, used to distinguish business fields from aliases. */
    inputSchema?: Record<string, unknown>,
    context?: ToolPermissionCheckContext,
  ): Promise<PermissionDecision>;
}
