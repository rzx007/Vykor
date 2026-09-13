import type { AgentDefinition } from "@openharness/coordinator";
import type {
  IHookExecutor,
  McpServerConfig,
  Settings,
  IToolRegistry,
  ToolDefinition,
} from "@openharness/core";
import { GOAL_ASSESSMENT_TOOL_NAME } from "./goal-assessment-tool.js";
import { getSkillsDir } from "@openharness/core";
import {
  discoverInstalledNativePlugins,
  buildNativePluginCompatibilityEnvironment,
  loadNativePlugin,
  verifyInstalledNativePlugin,
  type LoadedNativePlugin,
} from "@openharness/plugins";
import {
  createSkillRegistrySnapshot,
  SkillRegistry,
  findProjectSkillDirs,
  standardUserSkillDirs,
} from "@openharness/skills";
import { activateNativePluginTools, type NativeToolActivationResult } from "./native-tools/activate.js";
import {
  createPluginCapabilityInventory,
  selectPluginInstallationWinners,
  type LoadedPluginInstallation,
  type PluginCapabilityInventory,
} from "./plugin-capability-inventory.js";

export interface ExtensionToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  has(name: string): boolean;
}

export interface OpenHarnessExtensionContext {
  cwd: string;
  settings: Settings;
  skillRegistry: SkillRegistry;
  toolRegistry: ExtensionToolRegistry;
  hookExecutor: IHookExecutor;
}
export interface OpenHarnessAgentExtension { setup(context: OpenHarnessExtensionContext): Promise<void> | void; }
export interface OpenHarnessExtensionDiscovery {
  skillRegistry: SkillRegistry;
  plugins: LoadedNativePlugin[];
  agentDefinitions: AgentDefinition[];
  warnings: string[];
  mcpServers: Record<string, McpServerConfig>;
  pluginCapabilityInventory: PluginCapabilityInventory;
}

export async function discoverOpenHarnessExtensions(
  cwd: string,
  settings: Settings,
  options: { pluginsEnabled?: boolean } = {},
): Promise<OpenHarnessExtensionDiscovery> {
  let plugins: LoadedNativePlugin[] = [];
  const warnings: string[] = [];
  const installedPlugins = (settings.plugins?.enabled ?? true) && (options.pluginsEnabled ?? true)
    ? await discoverInstalledNativePlugins({ cwd, onWarning: (warning) => warnings.push(warning) })
    : [];
  const winnerSelection = selectPluginInstallationWinners(installedPlugins);
  const loadedInstallations: LoadedPluginInstallation[] = [];
  for (const record of winnerSelection.winners) {
    const verified = await verifyInstalledNativePlugin(record);
    warnings.push(...verified.diagnostics.map((item) => `${record.id}: ${item.message}`));
    if (verified.status !== "valid") {
      continue;
    }
    const loaded = await loadNativePlugin(verified.plugin);
    plugins.push(loaded);
    loadedInstallations.push({ record, plugin: loaded });
    warnings.push(...loaded.diagnostics.map((item) => `${record.id}: ${item.message}`));
  }
  const componentInventory = createPluginCapabilityInventory(loadedInstallations);
  const pluginCapabilityInventory: PluginCapabilityInventory = {
    ...componentInventory,
    diagnostics: [...winnerSelection.diagnostics, ...componentInventory.diagnostics],
  };
  warnings.push(...pluginCapabilityInventory.diagnostics.map((item) => item.message));
  const activeInstallations = loadedInstallations.filter(({ record }) =>
    pluginCapabilityInventory.plugins.has(record.id));
  plugins = activeInstallations.map(({ plugin }) => plugin);
  const skillRegistry = await createSkillRegistrySnapshot({
    plugins: plugins.flatMap((plugin) => plugin.components.skills?.value ?? []),
    userDirs: standardUserSkillDirs(),
    userDir: getSkillsDir(),
    projectDirs: await findProjectSkillDirs(cwd),
  });
  const agentDefinitions = plugins.flatMap((plugin) => plugin.components.agents?.value ?? []);
  const pluginMcpServers: Record<string, McpServerConfig> = {};
  for (const plugin of plugins) {
    const compatibilityEnv = buildNativePluginCompatibilityEnvironment({ manifest: plugin.manifest, root: plugin.root, cwd });
    for (const [name, server] of Object.entries(plugin.components.mcpServers?.value ?? {})) {
      pluginMcpServers[name] = server.type === "stdio" ? { ...server, env: { ...server.env, ...compatibilityEnv } } : server;
    }
  }
  return {
    skillRegistry,
    plugins,
    agentDefinitions,
    warnings,
    mcpServers: { ...pluginMcpServers, ...(settings.mcpServers ?? {}) },
    pluginCapabilityInventory,
  };
}

export async function configureDiscoveredExtensions(
  discovery: OpenHarnessExtensionDiscovery,
  context: {
    cwd: string;
    environmentKind?: "local" | "wsl";
    toolRegistry: IToolRegistry;
    hookExecutor: IHookExecutor;
    addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void;
  },
): Promise<NativeToolActivationResult[]> {
  const toolActivations: NativeToolActivationResult[] = [];
  for (const plugin of discovery.plugins) {
    for (const hook of plugin.components.hooks?.value ?? []) context.hookExecutor.register(hook);
    const activation = await activateNativePluginTools(plugin, {
      cwd: context.cwd,
      environmentKind: context.environmentKind,
      toolRegistry: context.toolRegistry,
      addCleanup: (cleanup, cleanupSync) => context.addCleanup(cleanup, cleanupSync),
      onLog: (message) => process.stderr.write(`${message}\n`),
    });
    toolActivations.push(activation);
    for (const diagnostic of activation.diagnostics) {
      process.stderr.write(`[plugins] ${plugin.manifest.id}: ${diagnostic.message}\n`);
    }
  }
  return toolActivations;
}

/** Add-only view exposed to programmatic extensions. */
export function createExtensionToolRegistry(
  registry: IToolRegistry,
  registeredNames?: string[],
): ExtensionToolRegistry {
  return {
    register(tool) {
      if (tool.name === GOAL_ASSESSMENT_TOOL_NAME) throw new Error(`${GOAL_ASSESSMENT_TOOL_NAME} is reserved for durable goal runs`);
      registry.register(tool, { kind: "extension" });
      registeredNames?.push(tool.name);
    },
    get: (name) => registry.get(name),
    getAll: () => registry.getAll(),
    has: (name) => registry.has(name),
  };
}
