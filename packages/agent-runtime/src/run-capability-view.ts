import type { IToolRegistry, RunAgentBinding, RunCapabilityView, RunMcpServerBinding, RunSkillBinding, RunToolBinding } from "@openharness/core";

export interface RunCapabilitySources {
  toolRegistry: IToolRegistry;
  pluginIds?: ReadonlySet<string>;
  pluginPreparationErrors?: ReadonlyMap<string, readonly string[]>;
  skills?: readonly RunSkillBinding[];
  agents?: readonly RunAgentBinding[];
  mcpServers?: readonly RunMcpServerBinding[];
}

export class PluginPreparationError extends Error {
  constructor(readonly pluginId: string, readonly reasons: readonly string[]) {
    super(`Plugin ${pluginId} is not ready: ${reasons.join("; ")}`);
    this.name = "PluginPreparationError";
  }
}

export function createRunCapabilityView(sources: RunCapabilitySources, pluginId?: string): RunCapabilityView {
  if (pluginId !== undefined && !sources.pluginIds?.has(pluginId)) {
    throw new Error(`Plugin is not available in this runtime: ${pluginId}`);
  }
  const preparationErrors = pluginId === undefined ? undefined : sources.pluginPreparationErrors?.get(pluginId);
  if (preparationErrors?.length) throw new PluginPreparationError(pluginId!, preparationErrors);
  const visible = (binding: { ownerPluginId?: string }) =>
    binding.ownerPluginId === undefined || binding.ownerPluginId === pluginId;
  const visibleDefinition = (binding: RunSkillBinding | RunAgentBinding) =>
    !(binding.definition.source === "plugin" && !binding.ownerPluginId) && visible(binding);
  const servers = sources.mcpServers ?? [];
  const byServerName = new Map(servers.map((server) => [server.serverName, server]));
  if (byServerName.size !== servers.length) {
    const ambiguous = servers.find((server, index) => servers.findIndex((other) => other.serverName === server.serverName) !== index)!;
    throw new Error(`Ambiguous MCP server name: ${ambiguous.serverName}`);
  }
  const tools: Array<[string, RunToolBinding]> = [];
  for (const definition of sources.toolRegistry.getAll()) {
    const source = sources.toolRegistry.inspect(definition.name)?.source;
    const server = source?.kind === "mcp" && source.id ? byServerName.get(source.id) : undefined;
    if (source?.kind === "mcp" && !server) continue;
    const ownerPluginId = source?.kind === "plugin" ? source.id : server?.ownerPluginId;
    // A plugin registration without its owner cannot become a baseline capability.
    if (source?.kind === "plugin" && !ownerPluginId) continue;
    if (!visible({ ownerPluginId })) continue;
    tools.push([definition.name, frozenCopy({
      ownerPluginId, definition, source, serverId: server?.serverId,
      // Capture both the function and its original receiver (some tools use WeakMap identity).
      invoke: definition.execute.bind(definition),
    })]);
  }
  return Object.freeze({
    pluginId,
    tools: readonlyMap(tools),
    skills: readonlyMap((sources.skills ?? []).filter(visibleDefinition).map((binding) => [binding.definition.name, frozenCopy(binding)])),
    agents: readonlyMap((sources.agents ?? []).filter(visibleDefinition).map((binding) => [binding.definition.name, frozenCopy(binding)])),
    mcpServers: readonlyMap(servers.filter(visible).map((binding) => [binding.serverId, frozenCopy(binding)])),
  });
}

function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenCopy(item)]))) as T;
  }
  return value;
}

/** Object.freeze(Map) still permits set/delete; expose only read operations. */
export function readonlyMap<T>(entries: Iterable<readonly [string, T]>): ReadonlyMap<string, T> {
  const inner = new Map(entries);
  const view: ReadonlyMap<string, T> = Object.freeze({
    size: inner.size,
    get: (key: string) => inner.get(key),
    has: (key: string) => inner.has(key),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    forEach: (callback: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown) =>
      inner.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  return view;
}
