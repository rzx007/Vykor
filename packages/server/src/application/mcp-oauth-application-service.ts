import { McpOAuthCredentialStore as FileMcpOAuthCredentialStore } from "@openharness/auth";
import {
  loadSettings,
  type McpOAuthAuthStatus,
  type McpServerConfig,
} from "@openharness/core";
import {
  loginMcpOAuth,
  McpOAuthRuntime,
  resolveMcpOAuthStatus,
  revokeMcpOAuthCredential,
  verifyMcpOAuthConnection,
  type McpOAuthCredentialStore,
} from "@openharness/mcp";

export interface McpOAuthServerSnapshot {
  name: string;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  authStatus: McpOAuthAuthStatus;
  scopes: string[];
}

export interface McpOAuthSnapshot {
  servers: McpOAuthServerSnapshot[];
}

export interface McpOAuthLoginRequest {
  name: string;
  scopes: string[];
  openBrowser(url: string): Promise<void>;
}

interface McpOAuthApplicationServiceDeps {
  loadSettings(): Promise<{ mcpServers?: Record<string, McpServerConfig> }>;
  store: McpOAuthCredentialStore;
  runtime: McpOAuthRuntime;
  login: typeof loginMcpOAuth;
  revoke: typeof revokeMcpOAuthCredential;
  verify: typeof verifyMcpOAuthConnection;
}

export class McpOAuthApplicationService {
  private readonly deps: McpOAuthApplicationServiceDeps;
  private readonly activeLogins = new Map<string, AbortController>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(overrides: Partial<McpOAuthApplicationServiceDeps> = {}) {
    const store = overrides.store ?? new FileMcpOAuthCredentialStore();
    this.deps = {
      loadSettings,
      store,
      runtime: new McpOAuthRuntime({ store }),
      login: loginMcpOAuth,
      revoke: revokeMcpOAuthCredential,
      verify: verifyMcpOAuthConnection,
      ...overrides,
    };
  }

  async snapshot(): Promise<McpOAuthSnapshot> {
    const settings = await this.deps.loadSettings();
    const servers = await Promise.all(
      Object.entries(settings.mcpServers ?? {}).map(async ([name, config]) => {
        const credential = await this.deps.store.get(name);
        const endpoint =
          config.type === "stdio" ? undefined : safeEndpoint(config.url);
        return {
          name,
          transport: config.type,
          ...(endpoint ? { endpoint } : {}),
          authStatus: resolveMcpOAuthStatus(config, credential),
          scopes:
            credential &&
            credential.serverUrl ===
              (config.type === "stdio" ? undefined : config.url)
              ? [...credential.tokens.scope]
              : config.type === "stdio"
                ? []
                : [...(config.oauth?.scopes ?? [])],
        } satisfies McpOAuthServerSnapshot;
      }),
    );
    return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async login(request: McpOAuthLoginRequest): Promise<McpOAuthSnapshot> {
    if (this.activeLogins.has(request.name))
      throw new Error(`MCP 服务正在登录：${request.name}`);
    const browser = new AbortController();
    this.activeLogins.set(request.name, browser);
    try {
      return await this.runServerOperation(request.name, async () => {
        const config = await this.requireServer(request.name);
        if (config.type !== "http")
          throw new Error("OAuth 登录仅支持 Streamable HTTP MCP 服务。");
        await this.deps.login(
          {
            serverName: request.name,
            config,
            scopes: request.scopes.length ? request.scopes : undefined,
            store: this.deps.store,
            signal: browser.signal,
          },
          {
            openBrowser: async (url) => {
              try {
                await request.openBrowser(url);
              } catch (error) {
                browser.abort(error);
                throw error;
              }
            },
            verifyConnection: (input) =>
              this.deps.verify({ ...input, runtime: this.deps.runtime }),
          },
        );
        return await this.snapshot();
      });
    } finally {
      if (this.activeLogins.get(request.name) === browser)
        this.activeLogins.delete(request.name);
    }
  }

  async logout(name: string): Promise<McpOAuthSnapshot> {
    this.activeLogins
      .get(name)
      ?.abort(new Error("MCP OAuth login cancelled by logout"));
    return await this.runServerOperation(name, async () => {
      await this.requireServer(name);
      await this.deps.revoke({ serverName: name, store: this.deps.store });
      return await this.snapshot();
    });
  }

  private async runServerOperation<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operations.get(name) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(name, settled);
    try {
      return await current;
    } finally {
      if (this.operations.get(name) === settled) this.operations.delete(name);
    }
  }

  private async requireServer(name: string): Promise<McpServerConfig> {
    const config = (await this.deps.loadSettings()).mcpServers?.[name];
    if (!config) throw new Error(`MCP 服务不存在：${name}`);
    return config;
  }
}

function safeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
