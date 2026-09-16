import type { McpServerStatus } from "@openharness/client";
import type { McpServerSnapshot } from "../../types";

export function mcpServerSnapshot(server: McpServerStatus): McpServerSnapshot {
  return {
    name: server.name,
    state: server.status,
    ...(server.error || server.command ? { detail: server.error ?? server.command } : {}),
    tool_count: server.toolCount,
    resource_count: server.resourceCount,
  };
}
