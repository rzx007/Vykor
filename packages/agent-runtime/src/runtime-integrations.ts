import type { McpServerConfig, RuntimeBundle, Settings } from "@openharness/core";
import { McpClientManager } from "@openharness/mcp";
import { getAllAgentDefinitions } from "@openharness/coordinator";
import { appendUserProfileUpdate } from "@openharness/prompts";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";

import type {
  OpenHarnessAgentExtension,
  OpenHarnessExtensionDiscovery,
} from "./extensions.js";
import {
  configureDiscoveredExtensions,
  createExtensionToolRegistry,
} from "./extensions.js";
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
}

/** Install integrations that need a fully constructed RuntimeBundle. */
export async function installRuntimeIntegrations(
  options: InstallRuntimeIntegrationsOptions,
): Promise<() => ReturnType<McpClientManager["getConnections"]>> {
  const { runtime } = options;
  const memory = options.memory;
  await configureDiscoveredExtensions(options.discovery, {
    cwd: options.cwd,
    environmentKind: options.executionEnvironment?.info.kind,
    toolRegistry: runtime.toolRegistry,
    hookExecutor: runtime.hookExecutor,
    addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
  });
  for (const extension of options.extensions ?? []) {
    const registeredNames: string[] = [];
    try {
      await extension.setup({
        cwd: options.cwd,
        settings: options.settings,
        skillRegistry: options.discovery.skillRegistry,
        toolRegistry: createExtensionToolRegistry(
          runtime.toolRegistry,
          registeredNames,
        ),
        hookExecutor: runtime.hookExecutor,
      });
    } catch (error) {
      for (const name of registeredNames) runtime.toolRegistry.unregister?.(name);
      throw error;
    }
  }

  const mcpManager = new McpClientManager({
    cwd: options.executionEnvironment?.workspace.executionRoot ?? options.cwd,
    settings: options.settings,
    sessionId: options.sessionId,
    processExecutor: options.executionEnvironment?.process,
  });
  runtime.addCleanup(() => mcpManager.disconnectAll());
  const mcpServers = selectMcpServersForEnvironment(
    options.mcpServers ?? options.discovery.mcpServers,
    options.executionEnvironment?.info,
  );
  if (Object.keys(mcpServers).length > 0) {
    await mcpManager.connectAll(mcpServers);
  }
  const registeredMcpToolNames: string[] = [];
  const mcpToolOwners = new Map(
    mcpManager.getConnectedTools().map((tool) => [
      `mcp__${tool.serverName}__${tool.name}`,
      tool.serverName,
    ]),
  );
  try {
    for (const tool of mcpManager.getAsToolDefinitions()) {
      const serverName = mcpToolOwners.get(tool.name);
      const server = serverName ? mcpServers[serverName] : undefined;
      runtime.toolRegistry.register({
        ...tool,
        execution: server?.type === "http" || server?.type === "sse"
          ? {
              domain: "control_plane",
              supportedEnvironments: ["local", "wsl"],
              network: true,
            }
          : {
              domain: "environment",
              supportedEnvironments: ["local", "wsl"],
            },
      }, {
        kind: "mcp",
        ...(serverName ? { id: serverName } : {}),
      });
      registeredMcpToolNames.push(tool.name);
    }
  } catch (error) {
    for (const name of registeredMcpToolNames) {
      runtime.toolRegistry.unregister?.(name);
    }
    throw error;
  }
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

  const inventory = options.discovery.pluginCapabilityInventory;
  const skills = options.discovery.skillRegistry.getAll().map((definition) => {
    const owner = inventory.skills.get(definition.name);
    return {
      definition,
      path: definition.path,
      ownerPluginId: owner?.path === definition.path ? owner.pluginId : undefined,
    };
  });
  const agents = [
    ...getAllAgentDefinitions([]).map((definition) => ({ definition })),
    ...options.discovery.agentDefinitions.map((definition) => ({
      definition,
      ownerPluginId: inventory.agents.get(definition.name)?.pluginId,
    })),
  ];
  const serverOwners = new Map([...inventory.mcpServers].map(([id, owner]) => [owner.serverName, { id, ...owner }]));
  const servers = Object.entries(mcpServers).map(([serverName, definition]) => {
    const pluginServer = serverOwners.get(serverName);
    // Explicit host configuration wins over a plugin server with the same name.
    const hostOwned = options.mcpServers !== undefined || options.settings.mcpServers?.[serverName] !== undefined;
    return {
      definition, serverName,
      serverId: !hostOwned && pluginServer ? pluginServer.id : `mcp:${serverName}`,
      ownerPluginId: !hostOwned ? pluginServer?.pluginId : undefined,
    };
  });
  runtime.createRunCapabilityView = (pluginId) => createRunCapabilityView({
    toolRegistry: runtime.toolRegistry,
    pluginIds: new Set(inventory.plugins.keys()),
    skills, agents, mcpServers: servers,
  }, pluginId);

  return () => mcpManager.getConnections();
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
