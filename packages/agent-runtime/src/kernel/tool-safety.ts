import type { AgentToolSafety } from "@vykor/agent-contracts";

/** Reject partial capabilities before a host starts resources or invokes tools. */
export function validateToolSafety(safety: AgentToolSafety | undefined): void {
  if (safety === undefined) return;
  if (!safety || !safety.operations || !safety.requiredPolicy
    || typeof safety.requiredPolicy.check !== "function"
    || ["prepare", "authorize", "dispatch", "settle", "reject"].some(
      key => typeof safety.operations[key as keyof AgentToolSafety["operations"]] !== "function",
    )) throw new Error("toolSafety requires both operations and requiredPolicy capabilities");
  if (safety.policyTimeoutMs !== undefined
    && (!Number.isFinite(safety.policyTimeoutMs) || safety.policyTimeoutMs <= 0))
    throw new Error("toolSafety.policyTimeoutMs must be positive and finite");
}
