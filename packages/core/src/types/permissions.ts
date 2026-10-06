export type PermissionMode = "default" | "plan" | "full_auto";

export interface PermissionRule {
  tool?: string;
  pathPattern?: string;
  commandPattern?: string;
  action: "allow" | "deny" | "ask";
}

export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  reason?: string;
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
