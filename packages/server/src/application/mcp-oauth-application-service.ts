import { McpOAuthCredentialStore as FileMcpOAuthCredentialStore } from "@openharness/auth";
import {
  createUnavailableMcpRuntimeCoordinator,
  loadSettings,
  saveSettings,
  withMcpServerOAuthScopes,
  type McpAuthServerSnapshot,
  type McpRuntimeConnectionCoordinator,
  type McpRemoteServerConfig,
  type McpRuntimeSyncResult,
  type McpServerConfig,
  type Settings,
} from "@openharness/core";
import {
  buildMcpAuthServerSnapshot,
  createMcpServerIdentity,
  loginMcpOAuth,
  McpOAuthError,
  McpOAuthRuntime,
  revokeMcpOAuthCredential,
  verifyMcpOAuthConnection,
  type McpOAuthCredentialStore,
  type McpOAuthLoginResult,
} from "@openharness/mcp";

export type McpOAuthServerSnapshot = McpAuthServerSnapshot;

export interface McpOAuthSnapshot {
  servers: McpAuthServerSnapshot[];
}

export interface McpOAuthLoginRequest {
  name: string;
  scopes: string[];
  openBrowser(url: string): Promise<void>;
  /** Print the authorization URL and accept a pasted callback URL instead. */
  noBrowser?: boolean;
  readCallbackUrl?(prompt: string): Promise<string>;
}

export type McpOAuthApplicationErrorCode =
  | "oauth-login-failed"
  | "oauth-login-verification-failed"
  | "oauth-saved-runtime-sync-failed"
  | "oauth-removed-runtime-sync-failed";

/**
 * Stable application-level OAuth failure. Details stay limited to the server
 * name, runtime count and sanitized messages; never tokens or headers.
 */
export class McpOAuthApplicationError extends Error {
  constructor(
    readonly code: McpOAuthApplicationErrorCode,
    message: string,
    readonly runtimeFailures: Array<{ runtimeId: string; message: string }> = [],
  ) {
    super(message);
    this.name = "McpOAuthApplicationError";
  }
}

export interface McpOAuthApplicationServiceDeps {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  store: McpOAuthCredentialStore;
  coordinator: McpRuntimeConnectionCoordinator;
  login: typeof loginMcpOAuth;
  revoke: typeof revokeMcpOAuthCredential;
  verify(input: {
    serverName: string;
    config: Parameters<typeof verifyMcpOAuthConnection>[0]["config"];
    store: McpOAuthCredentialStore;
  }): Promise<void>;
  warn?(message: string): void;
}

export class McpOAuthApplicationService {
  private readonly deps: McpOAuthApplicationServiceDeps;
  private readonly activeLogins = new Map<string, AbortController>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(overrides: Partial<McpOAuthApplicationServiceDeps> = {}) {
    const store = overrides.store ?? new FileMcpOAuthCredentialStore();
    this.deps = {
      loadSettings,
      saveSettings,
      store,
      coordinator: createUnavailableMcpRuntimeCoordinator(),
      login: loginMcpOAuth,
      revoke: revokeMcpOAuthCredential,
      verify: (input) =>
        verifyMcpOAuthConnection({
          serverName: input.serverName,
          config: input.config,
          runtime: new McpOAuthRuntime({ store: input.store }),
        }),
      ...overrides,
    };
  }

  async snapshot(): Promise<McpOAuthSnapshot> {
    const settings = await this.deps.loadSettings();
    const servers = await Promise.all(
      Object.entries(settings.mcpServers ?? {}).map(async ([name, config]) => {
        const credential = await this.deps.store.get(name);
        const identity = createMcpServerIdentity(name, config);
        const runtimeStatus = identity
          ? (await this.deps.coordinator.getStatus(identity)).status
          : "unavailable";
        return buildMcpAuthServerSnapshot({ name, config, credential, runtimeStatus });
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

        const result = await this.runLogin(request, config, browser);
        await this.commitVerifiedCredential(request.name, result);
        await this.synchronize(
          request.name,
          config,
          "oauth-saved-runtime-sync-failed",
          `OAuth authorization was saved for ${request.name}, but the active runtime failed to reconnect.`,
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
      const config = await this.requireServer(name);
      await this.backfillOAuthScopes(name, config).catch((error) => {
        this.deps.warn?.(
          `Could not backfill OAuth scopes for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await this.deps.revoke({ serverName: name, store: this.deps.store });
      await this.synchronize(
        name,
        config,
        "oauth-removed-runtime-sync-failed",
        `OAuth credentials were removed for ${name}, but the active runtime failed to disconnect.`,
      );
      return await this.snapshot();
    });
  }

  private async runLogin(
    request: McpOAuthLoginRequest,
    config: McpRemoteServerConfig,
    browser: AbortController,
  ): Promise<McpOAuthLoginResult> {
    try {
      return await this.deps.login(
        {
          serverName: request.name,
          config,
          scopes: request.scopes.length ? request.scopes : undefined,
          store: this.deps.store,
          signal: browser.signal,
          ...(request.noBrowser ? { noBrowser: true } : {}),
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
          ...(request.readCallbackUrl ? { readCallbackUrl: request.readCallbackUrl } : {}),
          verifyConnection: (input) => this.deps.verify(input),
        },
      );
    } catch (error) {
      if (browser.signal.aborted) throw error;
      if (error instanceof McpOAuthError && error.code === "oauth-login-verification-failed") {
        throw new McpOAuthApplicationError(
          "oauth-login-verification-failed",
          `OAuth authorization for ${request.name} was not accepted by the MCP server.`,
        );
      }
      throw new McpOAuthApplicationError(
        "oauth-login-failed",
        `OAuth login failed for ${request.name}.`,
      );
    }
  }

  /**
   * Commit the verified candidate inside the shared credential lock: patch the
   * latest settings (not the pre-login snapshot), save them, then replace the
   * credential in one `runExclusive` section. A failure here leaves the old
   * shared credential untouched.
   */
  private async commitVerifiedCredential(
    name: string,
    result: McpOAuthLoginResult,
  ): Promise<void> {
    try {
      await this.deps.store.runExclusive(name, async () => {
        const latest = await this.deps.loadSettings();
        const nextSettings = withMcpServerOAuthScopes(latest, name, result.credential.tokens.scope);
        await this.deps.saveSettings(nextSettings);
        return { next: result.credential, result: undefined };
      });
    } catch {
      throw new McpOAuthApplicationError(
        "oauth-login-failed",
        `OAuth authorization could not be saved for ${name}.`,
      );
    }
  }

  private async backfillOAuthScopes(
    name: string,
    config: McpServerConfig,
  ): Promise<void> {
    if (config.type !== "http" || config.oauth?.scopes?.length) return;
    await this.deps.store.runExclusive(name, async (current) => {
      if (!current) return { next: current, result: undefined };
      const latest = await this.deps.loadSettings();
      const nextSettings = withMcpServerOAuthScopes(latest, name, current.tokens.scope);
      await this.deps.saveSettings(nextSettings);
      return { next: current, result: undefined };
    });
  }

  private async synchronize(
    name: string,
    config: McpServerConfig,
    code: McpOAuthApplicationErrorCode,
    message: string,
  ): Promise<void> {
    if (config.type !== "http") return;
    const identity = createMcpServerIdentity(name, config);
    if (!identity) return;
    const result: McpRuntimeSyncResult = await this.deps.coordinator.synchronize(identity);
    if (result.failures.length > 0) {
      throw new McpOAuthApplicationError(
        code,
        `${message} ${result.failures.length} active runtime(s) reported failures.`,
        result.failures,
      );
    }
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
