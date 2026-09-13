import type {
  InstalledPluginRecord,
  LoadedNativePlugin,
  PluginDiagnostic,
} from "@openharness/plugins";

export interface PluginCapabilityOwner {
  pluginId: string;
  displayName: string;
  description: string;
  version: string;
  scope: InstalledPluginRecord["scope"];
  origin: InstalledPluginRecord["origin"];
  skillNames: readonly string[];
  mcpServerIds: readonly string[];
  nativeToolEntries: readonly string[];
  agentNames: readonly string[];
}

export interface PluginCapabilityInventory {
  plugins: ReadonlyMap<string, PluginCapabilityOwner>;
  skills: ReadonlyMap<string, { pluginId: string; path: string }>;
  mcpServers: ReadonlyMap<string, { pluginId: string; serverName: string }>;
  nativeToolEntries: ReadonlyMap<string, { pluginId: string }>;
  agents: ReadonlyMap<string, { pluginId: string }>;
  diagnostics: PluginDiagnostic[];
}

export interface LoadedPluginInstallation {
  record: InstalledPluginRecord;
  plugin: LoadedNativePlugin;
}

export function pluginMcpServerId(pluginId: string, serverName: string): string {
  return `plugin:${pluginId}:mcp:${serverName}`;
}

export function selectPluginInstallationWinners(
  records: readonly InstalledPluginRecord[],
): { winners: InstalledPluginRecord[]; diagnostics: PluginDiagnostic[] } {
  const byId = new Map<string, InstalledPluginRecord[]>();
  for (const record of records) {
    const group = byId.get(record.id) ?? [];
    group.push(record);
    byId.set(record.id, group);
  }

  const winners: InstalledPluginRecord[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  for (const [pluginId, candidates] of byId) {
    const managed = candidates.filter((candidate) => candidate.scope === "managed");
    const highestPriority = managed.length > 0
      ? managed
      : candidates.filter((candidate) => candidate.scope === "user");
    if (highestPriority.length !== 1) {
      const scope = managed.length > 0 ? "managed" : "user";
      diagnostics.push({
        severity: "error",
        phase: "discover",
        code: "plugin_installation_ambiguous",
        message: `Cannot choose one ${scope} installation for plugin ${pluginId}`,
        pluginId,
        details: { scope, count: highestPriority.length },
      });
      continue;
    }
    winners.push(highestPriority[0]!);
  }
  return { winners, diagnostics };
}

export function createPluginCapabilityInventory(
  installations: readonly LoadedPluginInstallation[],
): PluginCapabilityInventory {
  const diagnostics: PluginDiagnostic[] = [];
  const excludedPluginIds = findComponentConflicts(installations, diagnostics);
  const active = installations.filter(({ record }) => !excludedPluginIds.has(record.id));
  const plugins = new Map<string, PluginCapabilityOwner>();
  const skills = new Map<string, { pluginId: string; path: string }>();
  const mcpServers = new Map<string, { pluginId: string; serverName: string }>();
  const nativeToolEntries = new Map<string, { pluginId: string }>();
  const agents = new Map<string, { pluginId: string }>();

  for (const { record, plugin } of active) {
    const pluginId = record.id;
    const skillNames = unique(plugin.components.skills?.value?.map((skill) => skill.name) ?? []);
    const mcpServerIds = Object.keys(plugin.components.mcpServers?.value ?? {})
      .map((serverName) => pluginMcpServerId(pluginId, serverName));
    const toolEntries = unique(
      plugin.components.tools?.value?.map((tool) => tool.declaredEntry) ?? [],
    );
    const agentNames = unique(plugin.components.agents?.value?.map((agent) => agent.name) ?? []);

    plugins.set(pluginId, {
      pluginId,
      displayName: plugin.manifest.displayName ?? plugin.manifest.name,
      description: plugin.manifest.description ?? "",
      version: record.currentVersion,
      scope: record.scope,
      origin: record.origin,
      skillNames,
      mcpServerIds,
      nativeToolEntries: toolEntries,
      agentNames,
    });
    for (const skill of plugin.components.skills?.value ?? []) {
      skills.set(skill.name, { pluginId, path: skill.path });
    }
    for (const serverName of Object.keys(plugin.components.mcpServers?.value ?? {})) {
      mcpServers.set(pluginMcpServerId(pluginId, serverName), { pluginId, serverName });
    }
    for (const entry of toolEntries) nativeToolEntries.set(entry, { pluginId });
    for (const agentName of agentNames) agents.set(agentName, { pluginId });
  }

  return { plugins, skills, mcpServers, nativeToolEntries, agents, diagnostics };
}

function findComponentConflicts(
  installations: readonly LoadedPluginInstallation[],
  diagnostics: PluginDiagnostic[],
): Set<string> {
  const excluded = new Set<string>();
  const componentNames = [
    ["skills", (item: LoadedPluginInstallation) =>
      item.plugin.components.skills?.value?.map((skill) => skill.name) ?? []],
    ["tools", (item: LoadedPluginInstallation) =>
      item.plugin.components.tools?.value?.map((tool) => tool.declaredEntry) ?? []],
    ["agents", (item: LoadedPluginInstallation) =>
      item.plugin.components.agents?.value?.map((agent) => agent.name) ?? []],
  ] as const;

  for (const [component, getNames] of componentNames) {
    const owners = new Map<string, Set<string>>();
    for (const item of installations) {
      for (const name of getNames(item)) {
        const pluginIds = owners.get(name) ?? new Set<string>();
        pluginIds.add(item.record.id);
        owners.set(name, pluginIds);
      }
    }
    for (const [name, ownerSet] of owners) {
      if (ownerSet.size < 2) continue;
      const pluginIds = [...ownerSet].sort();
      pluginIds.forEach((pluginId) => excluded.add(pluginId));
      diagnostics.push({
        severity: "error",
        phase: "discover",
        code: "plugin_component_name_conflict",
        message: `Plugin component name '${name}' is owned by multiple plugins: ${pluginIds.join(", ")}`,
        component,
        details: { name, pluginIds },
      });
    }
  }
  return excluded;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
