import type { AgentDefinition } from "@openharness/coordinator";
import type { McpServerConfig, Settings } from "@openharness/core";
import { getSkillsDir } from "@openharness/core";
import {
  discoverInstalledNativePlugins,
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
import {
  createPluginCapabilityInventory,
  selectPluginInstallationWinners,
  type LoadedPluginInstallation,
  type PluginCapabilityInventory,
} from "./plugin-capability-inventory.js";

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
    ? await discoverInstalledNativePlugins({ cwd })
    : [];
  const winnerSelection = selectPluginInstallationWinners(installedPlugins);
  const loadedInstallations: LoadedPluginInstallation[] = [];
  for (const record of winnerSelection.winners) {
    const verified = await verifyInstalledNativePlugin(record);
    warnings.push(...verified.diagnostics.map((item) => `${record.id}: ${item.message}`));
    if (verified.status !== "valid") continue;
    const loaded = await loadNativePlugin(verified.plugin);
    plugins.push(loaded);
    loadedInstallations.push({ record, plugin: loaded });
    warnings.push(...loaded.diagnostics.map((item) => `${record.id}: ${item.message}`));
  }

  const componentInventory = createPluginCapabilityInventory(loadedInstallations, {
    reservedMcpServerNames: Object.keys(settings.mcpServers ?? {}),
  });
  const pluginCapabilityInventory: PluginCapabilityInventory = {
    ...componentInventory,
    diagnostics: [...winnerSelection.diagnostics, ...componentInventory.diagnostics],
  };
  warnings.push(...pluginCapabilityInventory.diagnostics.map((item) => item.message));

  plugins = loadedInstallations
    .filter(({ record }) => pluginCapabilityInventory.plugins.has(record.id))
    .map(({ plugin }) => plugin);
  const skillRegistry = await createSkillRegistrySnapshot({
    plugins: plugins.flatMap((plugin) => plugin.components.skills?.value ?? []),
    userDirs: standardUserSkillDirs(),
    userDir: getSkillsDir(),
    projectDirs: await findProjectSkillDirs(cwd),
  });
  const agentDefinitions = plugins.flatMap((plugin) => plugin.components.agents?.value ?? []);
  const pluginMcpServers: Record<string, McpServerConfig> = {};
  for (const plugin of plugins) {
    for (const [name, server] of Object.entries(plugin.components.mcpServers?.value ?? {})) {
      pluginMcpServers[name] = server;
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