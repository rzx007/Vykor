export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  reason?: string;
}

export type PermissionMode = "default" | "plan" | "full_auto" | "ask" | "auto_review" | "full_access";

export interface AgentPermissionRequest {
  toolName: string;
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
  ): Promise<PermissionDecision>;
}
