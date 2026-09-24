import { readFile } from "node:fs/promises";
import type { McpServerConfig } from "@vykor/core";
import { resolveNativePluginPath } from "../paths.js";
import type { PluginComponentResult, ValidatedNativePlugin } from "../types.js";

function parseServer(name: string, raw: unknown): McpServerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${name} must be an object`);
  const row = raw as Record<string, unknown>;
  if (row.type === "stdio" && typeof row.command === "string" && row.command.trim() && row.url === undefined) {
    if (row.args !== undefined && (!Array.isArray(row.args) || !row.args.every((value) => typeof value === "string"))) {
      throw new Error(`${name}.args must be string[]`);
    }
    return row as unknown as McpServerConfig;
  }
  if ((row.type === "http" || row.type === "sse") && typeof row.url === "string" && row.url.trim() && row.command === undefined) {
    return row as unknown as McpServerConfig;
  }
  throw new Error(`${name} requires an explicit type and matching command/url`);
}

export async function loadNativeMcpServers(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<Record<string, McpServerConfig>>> {
  const servers: Record<string, McpServerConfig> = {};
  try {
    for (const declaredPath of plugin.manifest.components.mcpServers ?? []) {
      const file = await resolveNativePluginPath(plugin.root, declaredPath);
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP file must be an object");
      const rows = (raw as Record<string, unknown>).servers;
      if (rows === null || typeof rows !== "object" || Array.isArray(rows)) throw new Error("MCP file requires a servers object");
      for (const [name, value] of Object.entries(rows)) {
        if (servers[name] !== undefined) throw new Error(`duplicate MCP server: ${name}`);
        servers[name] = parseServer(name, value);
      }
    }
    return { status: "loaded", value: servers, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", value: servers, diagnostics: [{
      severity: "error", phase: "load", code: "native_mcp_invalid",
      message: `Cannot load Native MCP servers: ${String(error)}`, pluginId: plugin.manifest.id,
      component: "mcpServers",
    }] };
  }
}
