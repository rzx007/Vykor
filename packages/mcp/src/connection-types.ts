import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, ToolDefinition } from "@vykor/core";

export type McpTransportKind = "stdio" | "http" | "sse";

/** Check transport config because settings and plugins enter as JSON. */
export function resolveTransportKind(
  config: McpServerConfig
): McpTransportKind | { error: string } {
  const raw = config as unknown as Record<string, unknown>;
  const kind = raw.type;

  if (kind !== "stdio" && kind !== "http" && kind !== "sse") {
    return {
      error: "Invalid MCP server config: `type` must be `stdio`, `http`, or `sse`",
    };
  }

  if ((kind === "http" || kind === "sse") &&
      (typeof raw.url !== "string" || raw.url.trim().length === 0)) {
    return { error: `MCP ${kind} server requires a \`url\`` };
  }
  if (kind === "stdio" &&
      (typeof raw.command !== "string" || raw.command.trim().length === 0)) {
    return { error: "MCP stdio server requires a `command`" };
  }
  if (kind === "stdio" && (raw.url !== undefined || raw.headers !== undefined)) {
    return { error: "MCP stdio server cannot contain remote transport fields" };
  }
  if (kind !== "stdio" &&
      (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined)) {
    return { error: `MCP ${kind} server cannot contain stdio transport fields` };
  }

  return kind;
}

export interface McpResourceInfo {
  serverName: string;
  name: string;
  uri: string;
  description: string;
}

export interface McpConnection {
  name: string;
  config: McpServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  transport: McpTransportKind;
  authConfigured: boolean;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  error?: Error;
  /** Non-fatal transport-wise; selected plugins must still surface failed tool discovery. */
  toolError?: Error;
  /** Non-fatal error from listing resources (server connected but resources failed). */
  resourceError?: Error;
}

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: string;
  isError?: boolean;
}

/** Discovered but not yet published to the manager's current connections. */
export interface PreparedMcpConnection {
  readonly name: string;
  readonly connection: McpConnection;
  readonly client: Client;
  readonly transport: Transport;
  readonly tools: ToolDefinition[];
}

/** A successful activation can close the previous client after active runs settle. */
export type McpConnectionActivation =
  | { committed: true; closePrevious(): Promise<void> }
  | { committed: false; error: unknown; discardPrepared(): Promise<void> };
