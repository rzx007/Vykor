import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpRemoteServerConfig, McpServerConfig, Settings, ToolDefinition } from "@openharness/core";
import type { EnvironmentProcessExecutor } from "@openharness/environment";
import type { SandboxPolicy } from "@openharness/sandbox";
import { SandboxStdioClientTransport } from "./sandbox-stdio-transport.js";
import type { McpOAuthRuntime } from "./oauth/runtime-auth.js";

export type { McpServerConfig };

export type McpTransportKind = "stdio" | "http" | "sse";

/**
 * Decide which transport a server config should use.
 *
 * The current format requires an explicit transport and its required field.
 * Runtime checks remain because settings and plugin files enter as JSON.
 */
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

export class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();

  constructor(private readonly options: {
    cwd?: string;
    settings?: Settings;
    sessionId?: string;
    policy?: SandboxPolicy;
    processExecutor?: EnvironmentProcessExecutor;
    oauthRuntime?: McpOAuthRuntime;
  } = {}) {}

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    const kind = resolveTransportKind(config);
    const transportKind: McpTransportKind =
      typeof kind === "string" ? kind : "stdio";

    const connection: McpConnection = {
      name,
      config,
      status: "connecting",
      transport: transportKind,
      authConfigured:
        transportKind === "stdio"
          ? !!config.env
          : !!config.headers || (transportKind === "http" && !!this.options.oauthRuntime),
      tools: [],
      resources: [],
    };
    this.connections.set(name, connection);

    if (typeof kind !== "string") {
      // Invalid config: fail this connection in isolation, do not throw.
      connection.status = "error";
      connection.error = new Error(kind.error);
      return connection;
    }

    try {
      const transport = this.createTransport(name, kind, config);
      this.transports.set(name, transport);

      const client = new Client(
        { name: "openharness", version: "0.1.0" },
        { capabilities: {} }
      );
      client.onclose = () => {
        if (this.clients.get(name) !== client) return;
        connection.status = "disconnected";
        connection.error = new Error(`MCP connection closed: ${name}`);
        connection.tools = [];
        connection.resources = [];
        this.clients.delete(name);
        this.transports.delete(name);
      };
      await client.connect(transport);
      this.clients.set(name, client);

      const toolsResult = await client.listTools().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!/Method not found/i.test(message) || client.getServerCapabilities?.()?.tools) {
          connection.toolError = err instanceof Error ? err : new Error(message);
        }
        return { tools: [] };
      });
      const resourcesResult = await client.listResources().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // "Method not found" => server simply does not support resources.
        if (!/Method not found/i.test(message)) {
          connection.resourceError =
            err instanceof Error ? err : new Error(message);
        }
        return { resources: [] };
      });

      const tools: McpToolInfo[] = (toolsResult.tools as any[]).map((t) => ({
        serverName: name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));

      const resources: McpResourceInfo[] = (resourcesResult.resources as any[]).map(
        (r) => ({
          serverName: name,
          name: r.name ?? String(r.uri),
          uri: String(r.uri),
          description: r.description ?? "",
        })
      );

      if (this.clients.get(name) !== client) throw connection.error ?? new Error(`MCP connection closed: ${name}`);
      connection.tools = tools;
      connection.resources = resources;
      connection.status = "connected";
    } catch (err) {
      connection.status = "error";
      connection.error = err instanceof Error ? err : new Error(String(err));
      this.clients.delete(name);
      this.transports.delete(name);
    }

    return connection;
  }

  /** Build the SDK transport for a resolved kind. */
  private createTransport(
    name: string,
    kind: McpTransportKind,
    config: McpServerConfig
  ): Transport {
    switch (kind) {
      case "http":
        {
          const remote = config as McpRemoteServerConfig;
          const hasExplicitAuthorization = Object.keys(remote.headers ?? {})
            .some(key => key.toLowerCase() === "authorization");
        return new StreamableHTTPClientTransport(new URL(config.url!), {
          requestInit: { headers: config.headers },
          fetch: !hasExplicitAuthorization && this.options.oauthRuntime
            ? this.options.oauthRuntime.createFetch(name, remote)
            : undefined,
        });
        }
      case "sse":
        return new SSEClientTransport(new URL(config.url!), {
          requestInit: { headers: config.headers },
        });
      case "stdio":
      default:
        return new SandboxStdioClientTransport({
          command: config.command!,
          args: config.args,
          env: config.env as Record<string, string> | undefined,
          cwd: config.cwd ?? this.options.cwd,
          settings: this.options.settings,
          sessionId: this.options.sessionId,
          policy: this.options.policy,
          processExecutor: this.options.processExecutor,
        });
    }
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.allSettled(
      Object.entries(servers).map(([name, config]) => this.connect(name, config))
    );
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch { }
    }
    this.clients.delete(name);
    this.transports.delete(name);

    const connection = this.connections.get(name);
    if (connection) {
      connection.status = "disconnected";
      connection.tools = [];
      connection.resources = [];
      this.connections.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnect(name);
    }
  }

  async reconnect(name: string, config?: McpServerConfig): Promise<McpConnection | undefined> {
    if (config) {
      await this.disconnect(name);
      return this.connect(name, config);
    }
    const existing = this.connections.get(name);
    if (existing) {
      await this.disconnect(name);
      return this.connect(name, existing.config);
    }
    return undefined;
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  getConnections(): readonly McpConnection[] {
    return [...this.connections.values()];
  }

  getConnectedTools(): McpToolInfo[] {
    return [...this.connections.values()].flatMap((c) =>
      c.status === "connected" ? c.tools : []
    );
  }

  getConnectedResources(): McpResourceInfo[] {
    return [...this.connections.values()].flatMap((c) =>
      c.status === "connected" ? c.resources : []
    );
  }

  getAsToolDefinitions(): ToolDefinition[] {
    return this.getConnectedTools().map(
      (t): ToolDefinition => {
        const { serverName, name } = t;
        const client = this.clients.get(serverName);
        return {
          name: `mcp__${serverName}__${name}`,
          description: `[${serverName}] ${t.description}`,
          inputSchema: t.inputSchema,
          execute: async (input, context) => {
            if (!client || this.clients.get(serverName) !== client) {
              return {
                content: [{ type: "text", text: `MCP connection changed or closed: ${serverName}. Start a new Run to use the current connection.` }],
                isError: true,
              };
            }
            const result = await this.callClientTool(client, name, input, context.abortSignal);
            return {
              content: [{ type: "text" as const, text: result.content }],
              isError: result.isError,
            };
          },
        };
      }
    );
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    return await this.callClientTool(client, toolName, args, signal);
  }

  private async callClientTool(
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal ? { signal } : undefined,
      );
      const parts: string[] = [];
      for (const item of result.content as any[]) {
        if (item.type === "text") {
          parts.push(item.text ?? "");
        } else {
          parts.push(JSON.stringify(item));
        }
      }
      return {
        content: parts.join("\n").trim() || "(no output)",
        isError: !!(result.isError as boolean | undefined),
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    const result = await client.readResource({ uri }, signal ? { signal } : undefined);
    const parts: string[] = [];
    for (const item of result.contents as any[]) {
      if (item.text !== undefined) {
        parts.push(item.text);
      } else if (item.blob !== undefined) {
        parts.push(item.blob);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join("\n").trim();
  }
}

export { McpOAuthError } from "./oauth/errors.js";
export { assertIssuer, assertOAuthEndpoint, assertScopeSubset, parseScopes } from "./oauth/security.js";
export { createOAuthCallback, type OAuthCallbackController } from "./oauth/callback.js";
export { resolveMcpAuthMode, resolveMcpOAuthStatus } from "./oauth/status.js";
export {
  buildMcpAuthServerSnapshot,
  createMcpServerIdentity,
  fingerprintMcpEndpoint,
  normalizeMcpEndpoint,
  type BuildMcpAuthServerSnapshotInput,
} from "./oauth/snapshot.js";
export {
  loginMcpOAuth,
  revokeMcpOAuthCredential,
  type McpOAuthCredentialStore,
  type McpOAuthLoginDeps,
} from "./oauth/login.js";
export { McpOAuthRuntime } from "./oauth/runtime-auth.js";
export { verifyMcpOAuthConnection } from "./oauth/verify-connection.js";
