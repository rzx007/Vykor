import type { ToolContext, ToolResult } from "@vykor/core";

export function sandboxNetworkGuard(context: ToolContext): ToolResult | undefined {
  if (!context.settings?.sandbox?.enabled || context.settings.sandbox.network?.mode !== "none") return;
  return {
    content: [{ type: "text", text: "Web access is blocked by sandbox network policy (network.mode=none)." }],
    isError: true,
    failureKind: "policy",
    executionState: "not_started",
  };
}
