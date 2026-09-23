import { randomUUID } from "node:crypto";
import type {
  ActiveMcpRuntimeHandle,
  McpRuntimeRegistry,
  McpServerConfig,
  McpServerIdentity,
  RuntimeBundle,
  Settings,
  ToolDefinition,
} from "@openharness/core";
import { loadProjectSettings, loadSettings } from "@openharness/core";
import {
  createMcpServerIdentity,
  McpClientManager,
  McpOAuthRuntime,
} from "@openharness/mcp";
import { McpOAuthCredentialStore } from "@openharness/auth";
import { getAllAgentDefinitions } from "@openharness/coordinator";
import { appendUserProfileUpdate } from "@openharness/prompts";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";

import type {
  OpenHarnessAgentExtension,
  OpenHarnessExtensionDiscovery,
} from "./extensions.js";
import { createExtensionToolRegistry } from "./extensions.js";
import { activateDiscoveredPlugins } from "./plugin-activation.js";
import type { AgentMemoryRuntime } from "./memory-runtime.js";
import { createMcpAuthHost } from "./mcp-auth.js";
import { createRememberTool } from "./remember-tool.js";
import { getInternalToolRegistry } from "./default-runtime.js";
import { createRunCapabilityView } from "./run-capability-view.js";

export interface InstallRuntimeIntegrationsOptions {
  cwd: string;
  sessionId: string;
  settings: Settings;
  runtime: RuntimeBundle;
  discovery: OpenHarnessExtensionDiscovery;
  extensions?: OpenHarnessAgentExtension[];
  mcpServers?: Record<string, McpServerConfig>;
  memory?: AgentMemoryRuntime;
  executionEnvironment?: ExecutionEnvironmentHandle;
  /** Host-owned registry used to coordinate OAuth-driven Runtime reconnects. */
  mcpRuntimeRegistry?: McpRuntimeRegistry;
}

/** Install integrations that need a fully constructed RuntimeBundle. */
export async function installRuntimeIntegrations(
  options: InstallRuntimeIntegrationsOptions,
): Promise<{
  getConnections: () => ReturnType<McpClientManager["getConnections"]>;
  retainConnectionsForRun: () => () => void;
}> {
  const { runtime } = options;
  const memory = options.memory;
  const inventory = options.discovery.pluginCapabilityInventory;
  assertPluginMcpServerNamesAvailable(options);
  const toolActivations = await activateDiscoveredPlugins({
    plugins: options.discovery.plugins,
    cwd: options.cwd,
    environmentKind: options.executionEnvironment?.info.kind,
    toolRegistry: runtime.toolRegistry,
    hookExecutor: runtime.hookExecutor,
    addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
    onLog: (message) => process.stderr.write(`${message}\n`),
    onDiagnostic: (diagnostic, plugin) => {
      process.stderr.write(`[plugins] ${plugin.manifest.id}: ${diagnostic.message}\n`);
    },
  });
  await installProgrammaticExtensions(options);

  const credentialStore = new McpOAuthCredentialStore();
  const mcpOAuthRuntime = new McpOAuthRuntime({
    store: credentialStore,
    getConfiguredScopes: async (name, config) => {
      const latest = await loadSettings(undefined, { includeProject: true, projectRoot: options.cwd });
      const current = latest.mcpServers?.[name];
      return current?.type === "http" && current.url === config.url
        ? current.oauth?.scopes
        : config.oauth?.scopes;
    },
  });
  const mcpManager = new McpClientManager({
    cwd: options.executionEnvironment?.workspace.executionRoot ?? options.cwd,
    settings: options.settings,
    sessionId: options.sessionId,
    processExecutor: options.executionEnvironment?.process,
    oauthRuntime: mcpOAuthRuntime,
  });
  runtime.addCleanup(() => mcpManager.disconnectAll());
  const mcpServers = selectMcpServersForEnvironment(
    options.mcpServers ?? options.discovery.mcpServers,
    options.executionEnvironment?.info,
  );
  const enabledMcpServers = filterEnabledMcpServers(mcpServers);

  const serverOwners = new Map([...inventory.mcpServers].map(([id, owner]) => [owner.serverName, { id, ...owner }]));
  const projectDeclaresMcpServers = async (): Promise<boolean> => {
    const project = await loadProjectSettings(options.cwd);
    return project?.mcpServers !== undefined;
  };
  // Where each configured server came from, recorded at session start and
  // updated as global configuration is reconciled. Only "global" servers
  // participate in global status aggregation and global reconcile.
  const connectionSources = new Map<string, McpConnectionSource>();
  const sessionProjectOverrides = await projectDeclaresMcpServers();
  for (const serverName of Object.keys(mcpServers)) {
    const fromHost =
      options.mcpServers?.[serverName] !== undefined ||
      options.settings.mcpServers?.[serverName] !== undefined;
    if (fromHost) connectionSources.set(serverName, sessionProjectOverrides ? "project" : "global");
    else if (serverOwners.has(serverName)) connectionSources.set(serverName, "plugin");
    else connectionSources.set(serverName, "unknown");
  }
  const connectionSource = (name: string): McpConnectionSource =>
    connectionSources.get(name) ?? "unknown";
  const setConnectionSource = (name: string, source: McpConnectionSource): void => {
    connectionSources.set(name, source);
  };
  const rememberServerConfig = (name: string, config: McpServerConfig): void => {
    mcpServers[name] = config;
    setConnectionSource(name, "global");
  };
  const forgetServerConfig = (name: string): void => {
    delete mcpServers[name];
    connectionSources.delete(name);
  };
  const resolveGlobalServer = async (name: string): Promise<McpServerConfig | undefined> => {
    return (await loadSettings()).mcpServers?.[name];
  };

  const runtimeRegistry = options.mcpRuntimeRegistry;
  const identityFor = (name: string): McpServerIdentity | undefined => {
    const config = mcpServers[name];
    return config ? createMcpServerIdentity(name, config) : undefined;
  };
  const executionFor = (name: string): ToolDefinition["execution"] => {
    const server = mcpServers[name];
    return server?.type === "http" || server?.type === "sse"
      ? { domain: "control_plane", supportedEnvironments: ["local", "wsl"], network: true }
      : { domain: "environment", supportedEnvironments: ["local", "wsl"] };
  };
  const commitMcpTools = (name: string, tools: ToolDefinition[]): void => {
    runtime.toolRegistry.replaceBySource(
      { kind: "mcp", id: name },
      tools.map((tool) => ({ ...tool, execution: executionFor(name) })),
    );
  };
  const connectionErrors = new Map<string, string>();

  // Publish a prepared connection only while the caller's generation guard
  // still holds. The guard is re-checked after staging, right before the atomic
  // activation, so a concurrent disable/delete/address change can never publish
  // a stale connection or its tools.
  const stageAndActivate = async (
    name: string,
    config: McpServerConfig,
    guard: () => boolean,
  ): Promise<void> => {
    if (!guard()) return;
    let prepared;
    try {
      prepared = await mcpManager.prepareConnection(name, config);
    } catch (error) {
      // Connection setup failures are isolated per server and never fatal.
      throw new McpConnectionStageError(error);
    }
    if (!guard()) {
      await prepared.client.close().catch(() => undefined);
      return;
    }
    const activation = mcpManager.activatePreparedConnection(prepared, (tools) =>
      commitMcpTools(name, tools),
    );
    if (!activation.committed) {
      await activation.discardPrepared().catch(() => undefined);
      // A tool-commit conflict is a configuration error and stays fatal.
      throw activation.error;
    }
    await activation.closePrevious();
  };

  const disconnectServer = async (name: string): Promise<void> => {
    runtime.toolRegistry.replaceBySource({ kind: "mcp", id: name }, []);
    await mcpManager.disconnect(name);
  };

  if (runtimeRegistry) {
    const unregister = runtimeRegistry.register(createMcpRuntimeHandle({
      sessionId: options.sessionId,
      cwd: options.cwd,
      identityFor,
      mcpServers,
      mcpManager,
      oauthRuntime: mcpOAuthRuntime,
      stageAndActivate,
      disconnectServer,
      registry: runtimeRegistry,
      connectionSource,
      rememberServerConfig,
      forgetServerConfig,
      projectOverridesMcpServers: projectDeclaresMcpServers,
      resolveGlobalServer,
    }));
    runtime.addCleanup(() => unregister());
  }

  await Promise.all(
    Object.entries(enabledMcpServers).map(async ([name, config]) => {
      const identity = identityFor(name);
      const generation = runtimeRegistry && identity
        ? runtimeRegistry.currentGeneration(identity)
        : 0;
      const guard = runtimeRegistry && identity
        ? () => runtimeRegistry.currentGeneration(identity) === generation
        : () => true;
      try {
        await stageAndActivate(name, config, guard);
      } catch (error) {
        if (error instanceof McpConnectionStageError) {
          connectionErrors.set(name, error.message);
          // Keep the failed attempt observable for plugin readiness diagnostics.
          mcpManager.recordFailedConnection(name, config, error.cause);
          return;
        }
        throw error;
      }
    }),
  );

  runtime.queryEngine.setMcpManager(mcpManager);
  runtime.queryEngine.setMcpAuth(
    createMcpAuthHost({
      settings: options.settings,
      mcpManager,
      toolRegistry: getInternalToolRegistry(runtime.toolRegistry),
    }),
  );

  if (memory) {
    runtime.toolRegistry.register(createRememberTool({
      appendUserProfile: appendUserProfileUpdate,
      projectMemory: memory.manager,
    }), { kind: "runtime", id: "memory" });
  }
  runtime.queryEngine.setMemoryRetriever(
    memory
      ? (userInput) => memory.retrieve(userInput)
      : undefined,
  );

  const skills = options.discovery.skillRegistry.getRunCandidates().map((definition) => {
    const owner = inventory.skills.get(definition.name);
    return {
      definition,
      path: definition.path,
      ownerPluginId: definition.source === "plugin" && owner?.path === definition.path ? owner.pluginId : undefined,
    };
  });
  const agents = [
    ...getAllAgentDefinitions([]).map((definition) => ({ definition })),
    ...options.discovery.agentDefinitions.map((definition) => ({
      definition,
      ownerPluginId: inventory.agents.get(definition.name)?.pluginId,
    })),
  ];

  runtime.createRunCapabilityView = (pluginId) => {
    const errors: string[] = [];
    if (pluginId !== undefined) {
      const plugin = options.discovery.plugins.find((item) => item.manifest.id === pluginId);
      errors.push(...(plugin?.diagnostics.filter((item) => item.severity === "error").map((item) => item.message) ?? []));
      const activation = toolActivations.find((item) => item.pluginId === pluginId);
      if (inventory.plugins.get(pluginId)?.nativeToolEntries.length &&
          (!activation || (activation.host?.state ?? activation.state) !== "active")) {
        errors.push(`Native Tools: ${activation?.diagnostics.map((item) => item.message).join("; ") || "host is not active"}`);
      }
      for (const { pluginId: owner, serverName } of inventory.mcpServers.values()) {
        if (owner !== pluginId) continue;
        const connection = mcpManager.getConnection(serverName);
        if (connection?.status !== "connected") {
          errors.push(`MCP ${serverName}: ${connection?.error?.message ?? connectionErrors.get(serverName) ?? "server is not connected in this environment"}`);
        } else {
          for (const error of [connection.toolError, connection.resourceError]) {
            if (error) errors.push(`MCP ${serverName}: ${error.message}`);
          }
        }
      }
    }
    // Bindings are derived from the live connections and their recorded source,
    // not from the install-time snapshot, so a reconciled add/remove/change is
    // reflected in the very next run without rebuilding the session.
    const connectedServers = Object.entries(mcpServers)
      .filter(([serverName]) => mcpManager.getConnection(serverName)?.status === "connected")
      .map(([serverName, definition]) => {
        const pluginServer = serverOwners.get(serverName);
        // Name conflicts were rejected before any plugin activation or connection.
        const hostOwned = connectionSource(serverName) === "global";
        return {
          definition, serverName,
          serverId: !hostOwned && pluginServer ? pluginServer.id : `mcp:${serverName}`,
          ownerPluginId: !hostOwned ? pluginServer?.pluginId : undefined,
        };
      });
    return createRunCapabilityView({
      toolRegistry: runtime.toolRegistry,
      pluginIds: new Set(inventory.plugins.keys()),
      pluginPreparationErrors: pluginId === undefined ? undefined : new Map([[pluginId, errors]]),
      skills, agents, mcpServers: connectedServers,
    }, pluginId);
  };

  return {
    getConnections: () => mcpManager.getConnections(),
    retainConnectionsForRun: () => mcpManager.retainCurrentConnections(),
  };
}

function assertPluginMcpServerNamesAvailable(options: InstallRuntimeIntegrationsOptions): void {
  const pluginServerNames = new Set<string>();
  for (const { serverName } of options.discovery.pluginCapabilityInventory.mcpServers.values()) {
    if (pluginServerNames.has(serverName) || options.mcpServers?.[serverName] || options.settings.mcpServers?.[serverName]) {
      throw new Error(`MCP server name '${serverName}' conflicts with another owner; independent bindings are required`);
    }
    pluginServerNames.add(serverName);
  }
}

async function installProgrammaticExtensions(options: InstallRuntimeIntegrationsOptions): Promise<void> {
  const { runtime } = options;
  for (const extension of options.extensions ?? []) {
    const registeredNames: string[] = [];
    try {
      await extension.setup({
        cwd: options.cwd,
        settings: options.settings,
        skillRegistry: options.discovery.skillRegistry,
        toolRegistry: createExtensionToolRegistry(runtime.toolRegistry, registeredNames),
        hookExecutor: runtime.hookExecutor,
      });
    } catch (error) {
      for (const name of registeredNames) runtime.toolRegistry.unregister?.(name);
      throw error;
    }
  }
}

/** Marks a per-server connection setup failure so it can be isolated. */
class McpConnectionStageError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "McpConnectionStageError";
  }
}

/** Where a session's configured MCP server came from. */
export type McpConnectionSource = "global" | "project" | "plugin" | "unknown";

/** @internal Exposed for focused tests of the Runtime handle contract. */
export interface CreateMcpRuntimeHandleInput {
  sessionId: string;
  cwd: string;
  identityFor(name: string): McpServerIdentity | undefined;
  mcpServers: Record<string, McpServerConfig>;
  mcpManager: McpClientManager;
  oauthRuntime: McpOAuthRuntime;
  registry: McpRuntimeRegistry;
  stageAndActivate(
    name: string,
    config: McpServerConfig,
    guard: () => boolean,
  ): Promise<void>;
  disconnectServer(name: string): Promise<void>;
  /** Recorded source for a configured server ("unknown" when unrecorded). */
  connectionSource(name: string): McpConnectionSource;
  /** Remember the latest global config and mark the server globally owned. */
  rememberServerConfig(name: string, config: McpServerConfig): void;
  /** Drop a server that no longer exists in global settings. */
  forgetServerConfig(name: string): void;
  /** Whether the session's project settings declare `mcpServers` (whole-list override). */
  projectOverridesMcpServers(): Promise<boolean>;
  /** Latest global settings entry for `name` (ignores project settings). */
  resolveGlobalServer(name: string): Promise<McpServerConfig | undefined>;
}

/**
 * Build the narrow Runtime handle the coordinator drives.
 *
 * `synchronize` never trusts a login/logout intent: it re-reads the shared
 * credential store's final state after acquiring the identity lock and then
 * reconnects or disconnects accordingly.
 *
 * `reconcileGlobal` re-checks the latest global configuration for one server
 * name. It skips sessions whose project settings override `mcpServers` and
 * sessions whose server is plugin-owned, so a global operation never touches a
 * project or plugin connection that merely shares the name.
 */
export function createMcpRuntimeHandle(input: CreateMcpRuntimeHandleInput): ActiveMcpRuntimeHandle {
  const identityGuard = (identity: McpServerIdentity, generation: number) =>
    () => input.registry.currentGeneration(identity) === generation;
  const namedGuard = (name: string, generation: number) =>
    () => input.registry.currentNamedGeneration(name) === generation;

  return {
    runtimeId: `${input.sessionId}:${randomUUID()}`,
    // Only globally-owned servers contribute to global status aggregation and
    // global OAuth synchronization. Project or plugin connections that happen to
    // share a name and URL must never be reported as the global server.
    identity: (name) =>
      input.connectionSource(name) === "global" ? input.identityFor(name) : undefined,
    getStatus: (identity) => {
      const connection = input.mcpManager.getConnection(identity.name);
      if (!connection) return "disconnected";
      if (connection.status === "connected") return "connected";
      if (connection.status === "error") return "error";
      return "disconnected";
    },
    async synchronize(identity, generation) {
      const config = input.mcpServers[identity.name];
      const current = input.identityFor(identity.name);
      if (!config || !current || current.endpointFingerprint !== identity.endpointFingerprint) return;
      const guard = identityGuard(identity, generation);
      if (!guard()) return;
      if (config.enabled === false) {
        await input.disconnectServer(identity.name);
        return;
      }

      const action = await input.oauthRuntime.getConnectionAction(identity.name, config);
      if (!guard()) return;
      if (action === "ignore") return;
      if (action === "connect") {
        await input.stageAndActivate(identity.name, config, guard);
      } else {
        await input.disconnectServer(identity.name);
      }
    },
    async reconcileGlobal(name, generation) {
      const guard = namedGuard(name, generation);
      if (!guard()) return;
      // Project settings replace the whole global list; global operations must
      // not touch any connection owned by such a session.
      if (await input.projectOverridesMcpServers()) return;

      const desired = await input.resolveGlobalServer(name);
      if (!guard()) return;
      const ownsGlobal = input.connectionSource(name) === "global" || desired !== undefined;
      if (!ownsGlobal) return;

      // Always withdraw the old connection and tools first, then reconnect from
      // the latest config. This covers delete, address change and disable.
      await input.disconnectServer(name);
      if (!guard()) return;

      if (desired && desired.enabled !== false) {
        input.rememberServerConfig(name, desired);
        await input.stageAndActivate(name, desired, guard);
      } else if (desired) {
        input.rememberServerConfig(name, desired);
      } else {
        input.forgetServerConfig(name);
      }
    },
  };
}

export function selectMcpServersForEnvironment(
  servers: Record<string, McpServerConfig>,
  environment?: Pick<ExecutionEnvironmentHandle["info"], "kind" | "networkMode">,
): Record<string, McpServerConfig> {
  if (!environment || environment.kind === "local") return servers;
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) =>
      server.type === "stdio" || environment.networkMode !== "none"
    ),
  );
}

/**
 * Keep the servers a new session should actually connect. `enabled: false`
 * servers stay configured (management snapshots still list them) but are
 * neither connected nor bound into the run capability view.
 */
export function filterEnabledMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, config]) => config.enabled !== false),
  );
}
