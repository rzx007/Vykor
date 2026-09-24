import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpRemoteServerConfig, McpServerConfig, Settings, ToolDefinition } from "@vykor/core";
import type { EnvironmentProcessExecutor } from "@vykor/environment";
import type { SandboxPolicy } from "@vykor/sandbox";
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

/**
 * A connection that has finished discovery but is not yet visible through the
 * manager's current-connection maps. Tool Definitions are bound to the staged
 * client, so they cannot reach the new connection until activation.
 */
export interface PreparedMcpConnection {
  readonly name: string;
  readonly connection: McpConnection;
  readonly client: Client;
  readonly transport: Transport;
  readonly tools: ToolDefinition[];
}

/**
 * Result of an atomic activation.
 *
 * `committed: true` means the staged connection is current and its tools were
 * committed; `closePrevious()` releases the replaced connection once active
 * Runs using it have settled. `committed:
 * false` means the tool commit failed and the previous connection was restored;
 * `discardPrepared()` releases the never-published staged connection.
 */
export type McpConnectionActivation =
  | { committed: true; closePrevious(): Promise<void> }
  | { committed: false; error: unknown; discardPrepared(): Promise<void> };

export class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private readonly runLeases = new Map<Client, number>();
  private readonly retiredClients = new Map<Client, string>();
  private readonly retiredClosures = new Map<Client, { name: string; work: Promise<void> }>();

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

    const placeholder: McpConnection = {
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
    this.connections.set(name, placeholder);

    if (typeof kind !== "string") {
      // Invalid config: fail this connection in isolation, do not throw.
      placeholder.status = "error";
      placeholder.error = new Error(kind.error);
      return placeholder;
    }

    try {
      const prepared = await this.prepareConnection(name, config);
      this.connections.set(name, prepared.connection);
      this.clients.set(name, prepared.client);
      this.transports.set(name, prepared.transport);
      return prepared.connection;
    } catch (err) {
      placeholder.status = "error";
      placeholder.error = err instanceof Error ? err : new Error(String(err));
      this.clients.delete(name);
      this.transports.delete(name);
      return placeholder;
    }
  }

  /**
   * Connect and discover a server without publishing it to the current maps.
   *
   * On failure the staged client is closed and the original error is thrown.
   * Callers must either activate the result or call `discardPrepared()`.
   */
  async prepareConnection(
    name: string,
    config: McpServerConfig,
  ): Promise<PreparedMcpConnection> {
    const kind = resolveTransportKind(config);
    if (typeof kind !== "string") throw new Error(kind.error);

    const connection: McpConnection = {
      name,
      config,
      status: "connecting",
      transport: kind,
      authConfigured:
        kind === "stdio"
          ? !!config.env
          : !!config.headers || (kind === "http" && !!this.options.oauthRuntime),
      tools: [],
      resources: [],
    };

    const transport = this.createTransport(name, kind, config);
    const client = new Client(
      { name: "vykor", version: "0.1.0" },
      { capabilities: {} }
    );
    let closed = false;
    client.onclose = () => {
      closed = true;
      if (this.clients.get(name) !== client) return;
      connection.status = "disconnected";
      connection.error = new Error(`MCP connection closed: ${name}`);
      connection.tools = [];
      connection.resources = [];
      this.clients.delete(name);
      this.transports.delete(name);
    };

    try {
      await client.connect(transport);

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

      connection.tools = (toolsResult.tools as any[]).map((t) => ({
        serverName: name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));

      connection.resources = (resourcesResult.resources as any[]).map((r) => ({
        serverName: name,
        name: r.name ?? String(r.uri),
        uri: String(r.uri),
        description: r.description ?? "",
      }));

      if (closed) throw connection.error ?? new Error(`MCP connection closed: ${name}`);
      connection.status = "connected";
      return {
        name,
        connection,
        client,
        transport,
        tools: connection.tools.map((tool) => this.buildToolDefinition(tool, client)),
      };
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Record a failed connection attempt so status and diagnostics stay
   * observable without exposing any staged client or transport.
   */
  recordFailedConnection(
    name: string,
    config: McpServerConfig,
    error: unknown,
  ): McpConnection {
    const kind = resolveTransportKind(config);
    const transportKind: McpTransportKind = typeof kind === "string" ? kind : "stdio";
    const connection: McpConnection = {
      name,
      config,
      status: "error",
      transport: transportKind,
      authConfigured:
        transportKind === "stdio"
          ? !!config.env
          : !!config.headers || (transportKind === "http" && !!this.options.oauthRuntime),
      tools: [],
      resources: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
    this.connections.set(name, connection);
    return connection;
  }

  /**
   * Atomically publish a prepared connection and commit its tools.
   *
   * The manager maps are switched, then `commitTools` runs synchronously, all
   * without awaiting. If the commit throws, the previous maps are restored in
   * the same critical section and the staged resources are returned for
   * out-of-band cleanup. No asynchronous cleanup happens inside this method.
   */
  activatePreparedConnection(
    prepared: PreparedMcpConnection,
    commitTools: (tools: ToolDefinition[]) => void,
  ): McpConnectionActivation {
    const { name } = prepared;
    const previousConnection = this.connections.get(name);
    const previousClient = this.clients.get(name);
    const previousTransport = this.transports.get(name);

    this.connections.set(name, prepared.connection);
    this.clients.set(name, prepared.client);
    this.transports.set(name, prepared.transport);

    try {
      commitTools(prepared.tools);
    } catch (error) {
      if (previousConnection) this.connections.set(name, previousConnection);
      else this.connections.delete(name);
      if (previousClient) this.clients.set(name, previousClient);
      else this.clients.delete(name);
      if (previousTransport) this.transports.set(name, previousTransport);
      else this.transports.delete(name);
      return {
        committed: false,
        error,
        discardPrepared: () => this.closeClient(prepared.client),
      };
    }

    return {
      committed: true,
      closePrevious: async () => {
        if (!previousClient) return;
        if ((this.runLeases.get(previousClient) ?? 0) > 0) {
          this.retiredClients.set(previousClient, name);
          return;
        }
        await this.closeClient(previousClient);
      },
    };
  }

  /** Keep the clients captured by one active Run until it settles. */
  retainCurrentConnections(): () => void {
    const captured = [...this.clients.values()];
    for (const client of captured) {
      this.runLeases.set(client, (this.runLeases.get(client) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const client of captured) {
        const remaining = (this.runLeases.get(client) ?? 1) - 1;
        if (remaining > 0) this.runLeases.set(client, remaining);
        else {
          this.runLeases.delete(client);
          if (this.retiredClients.has(client)) {
            void this.closeRetiredClient(client).catch(() => {
              process.stderr.write("[mcp] Deferred connection close failed\n");
            });
          }
        }
      }
    };
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

  /**
   * Close one connection and clear its local maps.
   *
   * Local state is always cleared, and any sanitized `client.close()` error is
   * rethrown so the caller (Runtime coordinator) can report it.
   */
  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    const retired = [...this.retiredClients].filter(([, owner]) => owner === name).map(([item]) => item);
    const closing = [...this.retiredClosures.values()].filter((item) => item.name === name).map((item) => item.work);
    const failures: unknown[] = [];
    try {
      const results = await Promise.allSettled([
        ...(client ? [Promise.resolve().then(() => client.close())] : []),
        ...retired.map((item) => this.closeRetiredClient(item)),
        ...closing,
      ]);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    } finally {
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
    if (failures.length) throw failures[0];
  }

  async disconnectAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const name of [...this.connections.keys()]) {
      try {
        await this.disconnect(name);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
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
    return this.getConnectedTools().map((tool) =>
      this.buildToolDefinition(tool, this.clients.get(tool.serverName)),
    );
  }

  /**
   * Build a Tool Definition bound to one concrete client.
   *
   * The closure refuses to call a client that is no longer the manager's
   * current client, so a captured Run can never be redirected to a newer
   * connection.
   */
  private buildToolDefinition(
    tool: McpToolInfo,
    client: Client | undefined,
  ): ToolDefinition {
    const { serverName, name } = tool;
    return {
      name: `mcp__${serverName}__${name}`,
      description: `[${serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      execute: async (input, context) => {
        if (!client || (this.clients.get(serverName) !== client && this.retiredClients.get(client) !== serverName)) {
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

  private async closeClient(client: Client | undefined): Promise<void> {
    if (!client) return;
    await client.close();
  }

  private closeRetiredClient(client: Client): Promise<void> {
    const existing = this.retiredClosures.get(client);
    if (existing) return existing.work;
    const name = this.retiredClients.get(client);
    if (!name) return Promise.resolve();
    this.retiredClients.delete(client);
    const work = Promise.resolve().then(() => client.close());
    this.retiredClosures.set(client, { name, work });
    void work.finally(() => this.retiredClosures.delete(client)).catch(() => undefined);
    return work;
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
  summarizeMcpEndpoint,
  type BuildMcpAuthServerSnapshotInput,
} from "./oauth/snapshot.js";
export {
  loginMcpOAuth,
  revokeMcpOAuthCredential,
  type McpOAuthCredentialStore,
  type McpOAuthLoginDeps,
  type McpOAuthLoginInput,
  type McpOAuthLoginResult,
} from "./oauth/login.js";
export { McpOAuthRuntime } from "./oauth/runtime-auth.js";
export { verifyMcpOAuthConnection } from "./oauth/verify-connection.js";
