import type { ToolOperationIntent, ToolOperationTicket } from "../tools/operations.js";

/** 强制规则由可信宿主提供；失败或超时不能放行工具。 */
export interface RequiredPolicyGate {
  check(input: { intent: ToolOperationIntent; operation: ToolOperationTicket; phase: "authorization" | "dispatch" }): Promise<{ allowed: boolean; policyVersion: string; reason?: string }>;
}
