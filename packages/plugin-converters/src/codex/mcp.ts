import type { VykorPluginManifestV1 } from "@vykor/plugins";
import { object } from "./source.js";

export interface MappedMcp {
  config?: Record<string, unknown>;
  permissions?: VykorPluginManifestV1["permissions"];
  reason: string;
}

function stringMap(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
}

export function mapCodexMcp(value: unknown, portable: boolean): MappedMcp {
  let row: Record<string, unknown>;
  try { row = object(value, "MCP server"); } catch { return { reason: "MCP server must be an object" }; }
  const unknown = Object.keys(row).filter(key => !["type", "command", "args", "env", "url", "headers"].includes(key));
  if (unknown.length) return { reason: `MCP fields have no verified Native equivalent: ${unknown.sort().join(", ")}` };
  if (/\$\{|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%/.test(JSON.stringify(row))) return { reason: "MCP environment or plugin-root interpolation is not supported" };
  if (row.command !== undefined && row.url !== undefined) return { reason: "MCP command and url cannot be combined" };
  if (typeof row.url === "string") {
    if (row.type !== undefined && row.type !== "http" && row.type !== "streamable-http" && row.type !== "sse") return { reason: "Unsupported MCP transport" };
    if (portable && row.type !== "streamable-http") return { reason: "Portable HTTP MCP requires streamable-http transport" };
    if (row.args !== undefined || row.env !== undefined || (row.headers !== undefined && !stringMap(row.headers))) return { reason: "Unsupported HTTP MCP options" };
    let url: URL;
    try { url = new URL(row.url); } catch { return { reason: "Invalid MCP URL" }; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) return { reason: "MCP requires an HTTP(S) URL without credentials or a fragment" };
    return { config: { type: row.type === "sse" ? "sse" : "http", url: row.url, ...(row.headers === undefined ? {} : { headers: row.headers }) }, permissions: { network: [url.origin] }, reason: "MCP transport is adapted to Native; connection and authentication happen after installation" };
  }
  if (typeof row.command === "string" && /^[a-zA-Z0-9_-]+(?:\.exe)?$/.test(row.command)) {
    if ((row.type !== undefined && row.type !== "stdio") || (portable && row.type !== "stdio") || row.headers !== undefined) return { reason: "Unsupported stdio MCP options" };
    if (row.args !== undefined && (!Array.isArray(row.args) || !row.args.every(item => typeof item === "string"))) return { reason: "MCP args must be a string array" };
    if (row.env !== undefined && !stringMap(row.env)) return { reason: "MCP env must contain strings" };
    const args = (row.args ?? []) as string[];
    // Local scripts, implicit package downloads and shell code need a dependency/runtime contract.
    if (["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "sh", "bash", "cmd", "powershell", "pwsh"].includes(row.command.toLowerCase().replace(/\.exe$/, "")) || args.some(arg => /[\\/]|\.(?:[cm]?js|ts|py|sh|exe)$/.test(arg) || ["-e", "--eval", "-c", "--command"].includes(arg))) return { reason: "MCP local paths, shell code or dependency execution require explicit preparation not supported by this converter" };
    return { config: { type: "stdio", command: row.command, ...(row.args === undefined ? {} : { args }), ...(row.env === undefined ? {} : { env: row.env }) }, permissions: { process: [row.command] }, reason: "MCP runs an already-installed executable from PATH; availability is checked when connecting" };
  }
  return { reason: "MCP requires a supported remote URL or an installed executable name" };
}
