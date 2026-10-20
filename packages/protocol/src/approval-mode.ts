/** User-facing authorization presets, independent from read-only planning. */
export type ApprovalMode = "ask" | "auto_review" | "full_access";
export type WorkMode = "execute" | "plan";

/** Upgrade legacy stored values without granting broader access. */
export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  if (value === "ask" || value === "auto_review" || value === "full_access") return value;
  if (value === "default" || value === "plan") return "ask";
  if (value === "full_auto") return "auto_review";
  return undefined;
}

export function isWorkMode(value: unknown): value is WorkMode {
  return value === "execute" || value === "plan";
}

/** The low-level tool gate keeps its existing, stricter read-only ceiling. */
export function effectivePermissionMode(approval: ApprovalMode, work: WorkMode): "default" | "plan" | "full_auto" {
  return work === "plan" ? "plan" : approval === "full_access" ? "full_auto" : "default";
}
