import type { ApprovalMode, WorkMode } from "@vykor/agent-contracts/permissions";

/** The low-level tool gate keeps its existing, stricter read-only ceiling. */
export function effectivePermissionMode(approval: ApprovalMode, work: WorkMode): "default" | "plan" | "full_auto" {
  return work === "plan" ? "plan" : approval === "full_access" ? "full_auto" : "default";
}
