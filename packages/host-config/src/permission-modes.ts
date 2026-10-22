import type { ApprovalMode, WorkMode } from "@vykor/agent-contracts/permissions";

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
