import type { McpOAuthCredentialStore as McpOAuthCredentialStoreContract } from "@openharness/mcp";
import { McpOAuthCredentialStore as FileMcpOAuthCredentialStore } from "@openharness/auth";
import {
  assertValidMcpServerConfig,
  createUnavailableMcpRuntimeCoordinator,
  loadSettings,
  McpServerConfigError,
  SettingsConflictError,
  updateSettings,
  type McpAuthMode,
  type McpAuthServerSnapshot,
  type McpOAuthAuthStatus,
  type McpRemoteServerConfig,
  type McpRuntimeConnectionCoordinator,
  type McpRuntimeStatus,
  type McpServerConfig,
  type Settings,
} from "@openharness/core";
import { summarizeMcpEndpoint } from "@openharness/mcp";

import { McpOAuthApplicationService, type McpOAuthSnapshot } from "./mcp-oauth-application-service.js";

export type McpConfigApplicationErrorCode =
  | "mcp-not-found"
  | "mcp-name-conflict"
  | "mcp-config-conflict"
  | "mcp-invalid-config"
  | "mcp-credential-removal-failed"
  | "mcp-settings-write-failed";

/** Stable application-level failure. Never contains tokens or headers. */
export class McpConfigApplicationError extends Error {
  constructor(
    readonly code: McpConfigApplicationErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "McpConfigApplicationError";
  }
}

/**
 * Result of one configuration operation. `persisted` is about the settings
 * file; `runtimeFailures` is about the daemon's active-session reconciliation.
 * A saved config with a failed reconcile is still `persisted: true`.
 */
export interface McpConfigOperationResult {
  persisted: boolean;
  credentialRemoved: boolean;
  runtimeFailures: Array<{ runtimeId: string; message: string }>;
}

/** Secret-free list row for one globally configured MCP server. */
export interface McpServerSummary {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  /** Endpoint without userinfo/query/fragment, or the stdio command. */
  summary: string;
  authMode: McpAuthMode;
  authStatus: McpOAuthAuthStatus;
  scopes: string[];
  runtimeStatus: McpRuntimeStatus;
}

export interface McpConfigApplicationServiceDeps {
  loadSettings(): Promise<Settings>;
  updateSettings(
    change: (current: Settings) => Settings | Promise<Settings>,
  ): Promise<Settings>;
  snapshot(): Promise<McpOAuthSnapshot>;
  credentialStore: McpOAuthCredentialStoreContract;
  coordinator: McpRuntimeConnectionCoordinator;
  warn?(message: string): void;
}

/**
 * Manage the global `settings.mcpServers` map shared with `ohs mcp`.
 *
 * All writes go through the cross-process settings lock and only touch the
 * target entry, so concurrent CLI / Desktop / OAuth writes cannot clobber each
 * other. After a successful write the daemon is asked to reconcile the name in
 * every active session; reconcile failures are reported separately from the
 * persisted result instead of rolling the user's save back.
 */
export class McpConfigApplicationService {
  private readonly deps: McpConfigApplicationServiceDeps;

  constructor(overrides: Partial<McpConfigApplicationServiceDeps> = {}) {
    const credentialStore = overrides.credentialStore ?? new FileMcpOAuthCredentialStore();
    const coordinator = overrides.coordinator ?? createUnavailableMcpRuntimeCoordinator();
    this.deps = {
      loadSettings,
      updateSettings,
      credentialStore,
      coordinator,
      snapshot: () =>
        new McpOAuthApplicationService({ credentialStore, coordinator }).snapshot(),
      ...overrides,
    };
  }

  /** Secret-free list of globally configured servers. */
  async list(): Promise<{ servers: McpServerSummary[] }> {
    const [snapshot, settings] = await Promise.all([
      this.deps.snapshot(),
      this.deps.loadSettings(),
    ]);
    return {
      servers: snapshot.servers.map((server) =>
        toSummary(server, settings.mcpServers?.[server.name]),
      ),
    };
  }

  /** Full config for one server, returned only on an explicit edit/export request. */
  async getConfig(name: string): Promise<McpServerConfig> {
    const trimmed = assertName(name);
    const config = (await this.deps.loadSettings()).mcpServers?.[trimmed];
    if (!config) throw notFound(trimmed);
    return config;
  }

  /** The global `mcpServers` map only — never other settings or demo data. */
  async exportConfig(): Promise<{ mcpServers: Record<string, McpServerConfig> }> {
    const settings = await this.deps.loadSettings();
    return { mcpServers: { ...(settings.mcpServers ?? {}) } };
  }

  async add(input: { name: string; config: unknown }): Promise<McpConfigOperationResult> {
    const name = assertName(input.name);
    const config = this.validate(name, input.config);
    await this.persist((current) => {
      if (current.mcpServers?.[name]) {
        throw new McpConfigApplicationError("mcp-name-conflict", `MCP 服务已存在：${name}`);
      }
      return {
        ...current,
        mcpServers: { ...(current.mcpServers ?? {}), [name]: config },
      };
    });
    return this.result(true, false, name);
  }

  async update(input: {
    name: string;
    config: unknown;
    /** The config the editor opened; compared inside the lock to detect conflicts. */
    expectedConfig: unknown;
  }): Promise<McpConfigOperationResult> {
    const name = assertName(input.name);
    const config = this.validate(name, input.config);
    await this.persist((current) => {
      const existing = current.mcpServers?.[name];
      if (!existing) throw notFound(name);
      if (!sameConfig(existing, input.expectedConfig)) {
        throw new McpConfigApplicationError(
          "mcp-config-conflict",
          `MCP 服务 ${name} 已被其他入口修改，请刷新后重试。`,
          `settings.mcpServers.${name}`,
        );
      }
      return {
        ...current,
        mcpServers: { ...(current.mcpServers ?? {}), [name]: config },
      };
    });
    // A changed URL / auth identity makes any stored OAuth credential invalid.
    const credentialRemoved = authIdentityChanged(
      input.expectedConfig as McpServerConfig,
      config,
    )
      ? await this.clearCredential(name)
      : false;
    return this.result(true, credentialRemoved, name);
  }

  async remove(name: string): Promise<McpConfigOperationResult> {
    const trimmed = assertName(name);
    const settings = await this.deps.loadSettings();
    if (!settings.mcpServers?.[trimmed]) throw notFound(trimmed);

    // Clear credentials first: a failure here keeps the config so the user can
    // retry, and a cleared credential that cannot be followed by a config write
    // is reported as a partial success instead of a lost deletion.
    const credentialRemoved = await this.clearCredential(trimmed);
    try {
      await this.persist((current) => {
        const mcpServers = { ...(current.mcpServers ?? {}) };
        delete mcpServers[trimmed];
        return { ...current, mcpServers };
      });
    } catch {
      return { persisted: false, credentialRemoved, runtimeFailures: [] };
    }
    return this.result(true, credentialRemoved, trimmed);
  }

  async setEnabled(input: { name: string; enabled: boolean }): Promise<McpConfigOperationResult> {
    const name = assertName(input.name);
    await this.persist((current) => {
      const existing = current.mcpServers?.[name];
      if (!existing) throw notFound(name);
      return {
        ...current,
        mcpServers: {
          ...(current.mcpServers ?? {}),
          [name]: withEnabled(existing, input.enabled),
        },
      };
    });
    return this.result(true, false, name);
  }

  private validate(name: string, config: unknown): McpServerConfig {
    try {
      assertValidMcpServerConfig(name, config);
    } catch (error) {
      if (error instanceof McpServerConfigError) {
        throw new McpConfigApplicationError("mcp-invalid-config", error.message, error.field);
      }
      throw error;
    }
    return config;
  }

  private async clearCredential(name: string): Promise<boolean> {
    try {
      return await this.deps.credentialStore.delete(name);
    } catch {
      throw new McpConfigApplicationError(
        "mcp-credential-removal-failed",
        `无法清除 MCP 服务 ${name} 的凭据，配置未修改。`,
      );
    }
  }

  private async persist(change: (current: Settings) => Settings): Promise<Settings> {
    try {
      return await this.deps.updateSettings(change);
    } catch (error) {
      if (error instanceof McpConfigApplicationError || error instanceof SettingsConflictError) {
        throw error;
      }
      throw new McpConfigApplicationError("mcp-settings-write-failed", "MCP 配置保存失败。");
    }
  }

  private async result(
    persisted: boolean,
    credentialRemoved: boolean,
    name: string,
  ): Promise<McpConfigOperationResult> {
    return { persisted, credentialRemoved, runtimeFailures: await this.reconcile(name) };
  }

  private async reconcile(name: string): Promise<Array<{ runtimeId: string; message: string }>> {
    try {
      const result = await this.deps.coordinator.reconcileGlobal(name);
      return result.failures;
    } catch {
      return [{ runtimeId: "daemon", message: "MCP runtime control request failed" }];
    }
  }
}

function toSummary(
  server: McpAuthServerSnapshot,
  config: McpServerConfig | undefined,
): McpServerSummary {
  return {
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    summary: summarize(config, server),
    authMode: server.authMode,
    authStatus: server.authStatus,
    scopes: [...server.scopes],
    runtimeStatus: server.runtimeStatus,
  };
}

function summarize(
  config: McpServerConfig | undefined,
  server: McpAuthServerSnapshot,
): string {
  if (config?.type === "stdio") return config.command;
  const url = config?.url;
  if (url) return summarizeMcpEndpoint(url) ?? "";
  if (server.endpoint) return summarizeMcpEndpoint(server.endpoint) ?? "";
  return "";
}

function withEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  if (enabled) {
    const { enabled: _enabled, ...rest } = config;
    return rest as McpServerConfig;
  }
  return { ...config, enabled: false };
}

function authIdentity(config: McpServerConfig | undefined): string | undefined {
  if (!config || config.type === "stdio") return undefined;
  const remote = config as McpRemoteServerConfig;
  return JSON.stringify({
    type: remote.type,
    url: summarizeMcpEndpoint(remote.url) ?? remote.url,
    headers: remote.headers ?? {},
    oauth: remote.oauth ?? {},
  });
}

function authIdentityChanged(
  before: McpServerConfig | undefined,
  after: McpServerConfig,
): boolean {
  return authIdentity(before) !== authIdentity(after);
}

function assertName(name: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new McpConfigApplicationError("mcp-invalid-config", "MCP 服务名称不能为空。", "name");
  }
  return trimmed;
}

function notFound(name: string): McpConfigApplicationError {
  return new McpConfigApplicationError("mcp-not-found", `MCP 服务不存在：${name}`);
}

/** Order-insensitive deep equality for JSON-shaped MCP configs. */
function sameConfig(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
