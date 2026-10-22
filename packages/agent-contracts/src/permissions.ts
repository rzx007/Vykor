export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  reason?: string;
}
