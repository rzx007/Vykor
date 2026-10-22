export type PermissionMode = "default" | "plan" | "full_auto" | import("@vykor/protocol").ApprovalMode;

export interface PermissionRule {
  tool?: string;
  pathPattern?: string;
  commandPattern?: string;
  action: "allow" | "deny" | "ask";
}
