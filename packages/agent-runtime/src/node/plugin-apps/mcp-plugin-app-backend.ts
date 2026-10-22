import type { ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import type { CapturedMcpAppResources } from "@vykor/mcp";

import { parseMcpCallResultData } from "@vykor/agent-contracts";
import { captureAppToolBindings, capturedBackend, type CapturedPluginAppBackend, type PluginAppBackendCaptureInput, type PluginAppResultView } from "./plugin-app-backends.js";
import { readonlyMap } from "../plugins/run-capability-view.js";

export function captureMcpPluginAppBackend(input: PluginAppBackendCaptureInput & {
  serverId: string;
  resources: CapturedMcpAppResources;
  /** Actual installed definitions committed with this exact resources/client generation. */
  installedTools: readonly ToolDefinition[];
}): CapturedPluginAppBackend {
  if (input.definition.kind !== "mcp-server" || !input.resources.isCurrent()) throw new Error("plugin_app_backend_unavailable");
  const names = input.installedTools.filter(tool => input.toolRegistry.get(tool.name) === tool).map(tool => tool.name);
  const bindings = captureAppToolBindings(input, names, input.serverId);
  const prefix = `mcp__${input.definition.server}__`;
  // Official page names remain the server's names; checked execution uses the captured registered name.
  const pageBindings = readonlyMap([...bindings].filter(([name]) => name.startsWith(prefix))
    .map(([name, binding]) => [name.slice(prefix.length), binding] as const));
  return capturedBackend(input, Object.freeze({ kind: "mcp-server", ...input.resources }), pageBindings,
    captureAppToolBindings(input, names, input.serverId, true));
}

/** The durable original response is authoritative; no second MCP call or private metadata synthesis. */
export function mcpToolResultToAppResult(original: ToolResult): PluginAppResultView {
  if (!original.mcpResult) throw new Error("plugin_app_mcp_result_unavailable");
  return { result: parseMcpCallResultData(original.mcpResult) };
}
