import type { ToolHostPolicyPort } from "../ports/policy.js";
import type { ToolContext, ToolResult } from "@vykor/agent-contracts";

export function sandboxNetworkGuard(context: ToolContext, host: ToolHostPolicyPort = {}): ToolResult | undefined {
  if (context.environment?.info.networkMode !== "none" && (!host.settings?.sandbox?.enabled || host.settings.sandbox.network?.mode !== "none")) return;
  return {
    content: [{ type: "text", text: "Web access is blocked by sandbox network policy (network.mode=none)." }],
    isError: true,
    failureKind: "policy",
    executionState: "not_started",
  };
}
