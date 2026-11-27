import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { loadNodeAgentDefinitions } from "../definitions/definitions.js";
import type { AgentDefinition } from "@vykor/coordinator/definitions";
import type { McpServerConfig, Settings } from "@vykor/host-config";
import { getSkillsDir } from "@vykor/host-config";
import {
  discoverInstalledNativePlugins,
  loadNativePlugin,
  verifyInstalledNativePlugin,
  type LoadedNativePlugin,
  type PluginDiagnostic,
} from "@vykor/plugins";
import {
  createSkillRegistrySnapshot,
  type SkillDefinition,
  type SkillRegistry,
  findProjectSkillDirs,
  standardUserSkillDirs,
} from "@vykor/skills";
import {
  createPluginCapabilityInventory,
  selectPluginInstallationWinners,
  type LoadedPluginInstallation,
  type PluginCapabilityInventory,
} from "./plugin-capability-inventory.js";

export interface VykorExtensionDiscovery {
  skillRegistry: SkillRegistry;
  plugins: LoadedNativePlugin[];
  agentDefinitions: AgentDefinition[];
  warnings: string[];
  mcpServers: Record<string, McpServerConfig>;
  pluginCapabilityInventory: PluginCapabilityInventory;
}

interface PluginReads {
  installations: LoadedPluginInstallation[];
  diagnostics: PluginDiagnostic[];
  warnings: string[];
}

interface ExtensionReads {
  plugins?: Promise<PluginReads>;
  workspaceSkills?: Promise<readonly SkillDefinition[]>;
}

const sharedDiscovery = new AsyncLocalStorage<{ active: boolean; directories: Map<string, ExtensionReads> }>();

/** Reuse file reads only inside one operation. Each caller still applies its own settings. */
export function withSharedExtensionDiscovery<T>(operation: () => Promise<T>): Promise<T> {
  const scope = { active: true, directories: new Map<string, ExtensionReads>() };
  return sharedDiscovery.run(scope, async () => {
    try {
      return await operation();
    } finally {
      // Work spawned by this operation may inherit its async context and outlive it.
      scope.active = false;
      scope.directories.clear();
    }
  });
}

function sharedExtensionReads(cwd: string): ExtensionReads | undefined {
  const scope = sharedDiscovery.getStore();
  if (!scope?.active) return;
  const { directories } = scope;
  const key = resolve(cwd);
  const existing = directories.get(key);
  if (existing) return existing;
  const reads: ExtensionReads = {};
  directories.set(key, reads);
  return reads;
}

async function readInstalledPlugins(cwd: string): Promise<PluginReads> {
  const warnings: string[] = [];
  const { winners, diagnostics } = selectPluginInstallationWinners(await discoverInstalledNativePlugins({ cwd }));
  const installations: LoadedPluginInstallation[] = [];
  for (const record of winners) {
    const verified = await verifyInstalledNativePlugin(record);
    warnings.push(...verified.diagnostics.map((item) => `${record.id}: ${item.message}`));
    if (verified.status !== "valid") continue;
    const loaded = await loadNativePlugin(verified.plugin);
    installations.push({ record, plugin: loaded });
    warnings.push(...loaded.diagnostics.map((item) => `${record.id}: ${item.message}`));
  }
  return { installations, diagnostics, warnings };
}

async function loadWorkspaceSkillRegistry(cwd: string, plugins: readonly SkillDefinition[], bundled: boolean) {
  return createSkillRegistrySnapshot({
    bundled,
    plugins,
    userDirs: standardUserSkillDirs(),
    userDir: getSkillsDir(),
    projectDirs: await findProjectSkillDirs(cwd),
  });
}

export async function discoverVykorExtensions(
  cwd: string,
  settings: Settings,
  options: { pluginsEnabled?: boolean } = {},
): Promise<VykorExtensionDiscovery> {
  const reads = sharedExtensionReads(cwd);
  const pluginsEnabled = (settings.plugins?.enabled ?? true) && (options.pluginsEnabled ?? true);
  const installed = pluginsEnabled
    ? await (reads ? (reads.plugins ??= readInstalledPlugins(cwd)) : readInstalledPlugins(cwd))
    : { installations: [], diagnostics: [], warnings: [] };

  const componentInventory = createPluginCapabilityInventory(installed.installations, {
    reservedMcpServerNames: Object.keys(settings.mcpServers ?? {}),
  });
  const pluginCapabilityInventory: PluginCapabilityInventory = {
    ...componentInventory,
    diagnostics: [...installed.diagnostics, ...componentInventory.diagnostics],
  };
  const warnings = [...installed.warnings, ...pluginCapabilityInventory.diagnostics.map((item) => item.message)];

  const plugins = installed.installations
    .filter(({ record }) => pluginCapabilityInventory.plugins.has(record.id))
    .map(({ plugin }) => plugin);
  const pluginSkills = plugins.flatMap((plugin) => plugin.components.skills?.value ?? []);
  const skillRegistry = reads
    ? await createSkillRegistrySnapshot({ plugins: pluginSkills })
    : await loadWorkspaceSkillRegistry(cwd, pluginSkills, true);
  if (reads) {
    // Bundled skills were registered before plugins. User and project winners go last.
    const workspaceSkills = await (reads.workspaceSkills ??=
      loadWorkspaceSkillRegistry(cwd, [], false).then((registry) => registry.getNonPluginSkills()));
    for (const skill of workspaceSkills) skillRegistry.register({ ...skill });
  }
  const agentDefinitions = loadNodeAgentDefinitions(plugins.flatMap((plugin) => plugin.components.agents?.value ?? []));
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
