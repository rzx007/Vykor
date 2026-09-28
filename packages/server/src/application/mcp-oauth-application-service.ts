import { McpOAuthCredentialStore as FileMcpOAuthCredentialStore } from "@vykor/auth";
import {
  createUnavailableMcpRuntimeCoordinator,
  loadSettings,
  updateSettings,
  withMcpServerOAuthScopes,
  type McpAuthServerSnapshot,
  type McpRuntimeConnectionCoordinator,
  type McpRemoteServerConfig,
  type McpRuntimeSyncResult,
  type McpServerConfig,
  type Settings,
} from "@vykor/core";
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
} from "@vykor/mcp";

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
  readCallbackUrl?(prompt: string, signal?: AbortSignal): Promise<string>;
  /** Notify the caller that the authorization URL is ready; never opens a browser. */
  onAuthorizationUrl?(url: string): void | Promise<void>;
  onCallbackAccepted?(): void;
  onCallbackRejected?(error: McpOAuthError): void;
  /** External cancellation; combined with logout/cancel signals. */
  signal?: AbortSignal;
}

/** Result of a login that reached the commit point. */
export interface McpOAuthCommitOutcome {
  credentialCommitted: true;
  runtimeSync: McpRuntimeSyncResult;
}

export type McpOAuthApplicationErrorCode =
  | "oauth-not-required"
  | "oauth-login-failed"
  | "oauth-login-verification-failed"
  | "oauth-login-stale"
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
  updateSettings(
    change: (current: Settings) => Settings | Promise<Settings>,
  ): Promise<Settings>;
  credentialStore: McpOAuthCredentialStore;
  coordinator: McpRuntimeConnectionCoordinator;
  login: typeof loginMcpOAuth;
  revoke: typeof revokeMcpOAuthCredential;
  verify(input: {
    serverName: string;
    config: Parameters<typeof verifyMcpOAuthConnection>[0]["config"];
    store: McpOAuthCredentialStore;
    signal?: AbortSignal;
  }): Promise<void>;
  warn?(message: string): void;
}

/** Only the authorization-affecting fields; unrelated settings must not cancel a commit. */
interface AuthConfigSnapshot {
  url: string;
  resourceUrl?: string;
  callbackUrl?: string;
  callbackPort?: number;
  clientId?: string;
  scopes: string[];
}

const UNAVAILABLE_SYNC: McpRuntimeSyncResult = { status: "unavailable", affectedRuntimes: 0, failures: [] };

export class McpOAuthApplicationService {
  private readonly deps: McpOAuthApplicationServiceDeps;
  private readonly activeLogins = new Map<string, AbortController>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(overrides: Partial<McpOAuthApplicationServiceDeps> = {}) {
    const credentialStore = overrides.credentialStore ?? new FileMcpOAuthCredentialStore();
    this.deps = {
      loadSettings,
      updateSettings,
      credentialStore,
      coordinator: createUnavailableMcpRuntimeCoordinator(),
      login: loginMcpOAuth,
      revoke: revokeMcpOAuthCredential,
      verify: (input) =>
        verifyMcpOAuthConnection({
          serverName: input.serverName,
          config: input.config,
          runtime: new McpOAuthRuntime({ store: input.store }),
          signal: input.signal,
        }),
      ...overrides,
    };
  }

  async snapshot(): Promise<McpOAuthSnapshot> {
    const settings = await this.deps.loadSettings();
    const servers = await Promise.all(
      Object.entries(settings.mcpServers ?? {}).map(async ([name, config]) => {
        const credential = await this.deps.credentialStore.get(name);
        const identity = createMcpServerIdentity(name, config);
        const runtimeStatus = identity
          ? (await this.deps.coordinator.getStatus(identity)).status
          : "unavailable";
        return buildMcpAuthServerSnapshot({ name, config, credential, runtimeStatus });
      }),
    );
    return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /**
   * Existing CLI behavior: a committed credential whose Runtime sync failed is
   * reported as `oauth-saved-runtime-sync-failed` (non-zero exit) while the
   * credential itself stays valid.
   */
  async login(request: McpOAuthLoginRequest): Promise<McpOAuthSnapshot> {
    const outcome = await this.beginLogin(request);
    if (isSyncFailure(outcome.runtimeSync)) {
      throw new McpOAuthApplicationError(
        "oauth-saved-runtime-sync-failed",
        `OAuth authorization was saved for ${request.name}, but the active runtime failed to reconnect.`,
        outcome.runtimeSync.failures,
      );
    }
    return this.snapshot();
  }

  /**
   * Run a login to its commit point and report the outcome without converting a
   * Runtime warning into an authorization failure. Callers that need the
   * current state afterwards re-read the auth snapshot separately.
   */
  async beginLogin(request: McpOAuthLoginRequest): Promise<McpOAuthCommitOutcome> {
    if (this.activeLogins.has(request.name)) {
      throw new McpOAuthApplicationError("oauth-login-failed", `MCP 服务正在登录：${request.name}`);
    }
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    this.activeLogins.set(request.name, controller);
    try {
      return await this.runServerOperation(request.name, async () => {
        const config = await this.requireServer(request.name);
        if (config.type !== "http") throw new Error("OAuth 登录仅支持 Streamable HTTP MCP 服务。");

        const startEpoch = await this.deps.credentialStore.readLogoutEpoch(request.name);
        const startConfig = captureAuthConfig(config);
        const result = await this.runLogin({ ...request, signal }, config, controller);
        await this.commitVerifiedCredential(request.name, result, startEpoch, startConfig, signal);
        const runtimeSync = await this.synchronizeResult(request.name, config);
        return { credentialCommitted: true, runtimeSync };
      });
    } finally {
      if (this.activeLogins.get(request.name) === controller) this.activeLogins.delete(request.name);
    }
  }

  async logout(name: string): Promise<McpOAuthSnapshot> {
    this.activeLogins.get(name)?.abort(new DOMException("MCP OAuth login cancelled by logout", "AbortError"));
    return await this.runServerOperation(name, async () => {
      const config = await this.requireServer(name);
      // Take and delete under the file lock first: the epoch advances and the
      // record is gone even if the remote revocation or Runtime sync fails.
      const removed = await this.deps.credentialStore.takeAndDelete(name);
      if (removed && config.type === "http" && !config.oauth?.scopes?.length) {
        await this.deps.updateSettings((latest) =>
          withMcpServerOAuthScopes(latest, name, removed.tokens.scope),
        ).catch(() => {
          this.deps.warn?.(`Could not backfill OAuth scopes for ${name}.`);
        });
      }
      // Best-effort remote revocation of the record we already removed; never
      // re-read the store, so a concurrent new login is not revoked.
      await this.deps.revoke({ serverName: name, store: this.deps.credentialStore, credential: removed }).catch(() => undefined);
      const runtimeSync = await this.synchronizeResult(name, config);
      if (isSyncFailure(runtimeSync)) {
        throw new McpOAuthApplicationError(
          "oauth-removed-runtime-sync-failed",
          `OAuth credentials were removed for ${name}, but the active runtime failed to disconnect.`,
          runtimeSync.failures,
        );
      }
      return await this.snapshot();
    });
  }

  private async runLogin(
    request: McpOAuthLoginRequest,
    config: McpRemoteServerConfig,
    controller: AbortController,
  ): Promise<McpOAuthLoginResult> {
    try {
      return await this.deps.login(
        {
          serverName: request.name,
          config,
          scopes: request.scopes.length ? request.scopes : undefined,
          store: this.deps.credentialStore,
          signal: request.signal,
          ...(request.noBrowser ? { noBrowser: true } : {}),
        },
        {
          openBrowser: async (url) => {
            try {
              await request.openBrowser(url);
            } catch (error) {
              controller.abort(error);
              throw error;
            }
          },
          ...(request.readCallbackUrl ? { readCallbackUrl: request.readCallbackUrl } : {}),
          ...(request.onAuthorizationUrl ? { onAuthorizationUrl: request.onAuthorizationUrl } : {}),
          ...(request.onCallbackAccepted ? { onCallbackAccepted: request.onCallbackAccepted } : {}),
          ...(request.onCallbackRejected ? { onCallbackRejected: request.onCallbackRejected } : {}),
          verifyConnection: (input) => this.deps.verify(input),
        },
      );
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (error instanceof McpOAuthError && error.code === "oauth-login-verification-failed") {
        throw new McpOAuthApplicationError(
          "oauth-login-verification-failed",
          `OAuth authorization for ${request.name} was not accepted by the MCP server.`,
        );
      }
      if (error instanceof McpOAuthError && error.code === "oauth-not-required") {
        throw new McpOAuthApplicationError(
          "oauth-not-required",
          `MCP server ${request.name} does not require OAuth. Use it without browser authorization.`,
        );
      }
      throw new McpOAuthApplicationError(
        "oauth-login-failed",
        `OAuth login failed for ${request.name}.`,
      );
    }
  }

  /**
   * Commit the verified candidate inside the shared credential lock. The
   * captured logout epoch and authorization config must still match, otherwise
   * a login that started before a logout or config edit is rejected without
   * writing anything.
   */
  private async commitVerifiedCredential(
    name: string,
    result: McpOAuthLoginResult,
    startEpoch: number,
    startConfig: AuthConfigSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.credentialStore.runExclusive(name, async (_current, context) => {
        // Re-check cancellation only after the lock is held and before any write.
        if (signal?.aborted) throw signal.reason ?? new Error("OAuth login was cancelled");
        if (context.logoutEpoch !== startEpoch) {
          throw new McpOAuthError("oauth-login-stale", "OAuth login was superseded by a logout");
        }
        await this.deps.updateSettings((latest) => {
          // updateSettings may wait for its own queue/lock after the credential
          // lock was acquired. This is the last check before settings mutation.
          signal?.throwIfAborted();
          const latestConfig = latest.mcpServers?.[name];
          if (
            !latestConfig ||
            latestConfig.type !== "http" ||
            authConfigChanged(captureAuthConfig(latestConfig), startConfig)
          ) {
            throw new McpOAuthError("oauth-login-stale", "OAuth configuration changed while logging in");
          }
          return withMcpServerOAuthScopes(latest, name, result.credential.tokens.scope);
        });
        return { next: result.credential, result: undefined };
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof McpOAuthError && error.code === "oauth-login-stale") {
        throw new McpOAuthApplicationError(
          "oauth-login-stale",
          `OAuth configuration changed for ${name} before the authorization completed.`,
        );
      }
      throw new McpOAuthApplicationError(
        "oauth-login-failed",
        `OAuth authorization could not be saved for ${name}.`,
      );
    }
  }

  /** Never throws for a coordinator error; the failure is reported in the result. */
  private async synchronizeResult(name: string, config: McpServerConfig): Promise<McpRuntimeSyncResult> {
    if (config.type !== "http") return UNAVAILABLE_SYNC;
    const identity = createMcpServerIdentity(name, config);
    if (!identity) return UNAVAILABLE_SYNC;
    try {
      return await this.deps.coordinator.synchronize(identity);
    } catch {
      return {
        status: "error",
        affectedRuntimes: 0,
        failures: [{ runtimeId: "daemon", message: "MCP runtime control request failed" }],
      };
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

function isSyncFailure(result: McpRuntimeSyncResult): boolean {
  return result.status === "error" || result.failures.length > 0;
}

function captureAuthConfig(config: McpRemoteServerConfig): AuthConfigSnapshot {
  return {
    url: config.url,
    resourceUrl: config.oauth?.resourceUrl,
    callbackUrl: config.oauth?.callbackUrl,
    callbackPort: config.oauth?.callbackPort,
    clientId: config.oauth?.clientId,
    scopes: [...(config.oauth?.scopes ?? [])],
  };
}

function authConfigChanged(left: AuthConfigSnapshot, right: AuthConfigSnapshot): boolean {
  if (
    left.url !== right.url ||
    left.resourceUrl !== right.resourceUrl ||
    left.callbackUrl !== right.callbackUrl ||
    left.callbackPort !== right.callbackPort ||
    left.clientId !== right.clientId
  ) return true;
  const a = new Set(left.scopes);
  const b = new Set(right.scopes);
  return a.size !== b.size || [...a].some((scope) => !b.has(scope));
}
