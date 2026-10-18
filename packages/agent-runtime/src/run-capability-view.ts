import { toolDefinitionIdentity, type IToolRegistry, type RunAgentBinding, type RunCapabilityView, type RunMcpServerBinding, type RunPluginUiBinding, type RunSkillBinding, type RunToolBinding } from "@vykor/core";

export interface RunCapabilitySources {
  toolRegistry: IToolRegistry;
  pluginIds?: ReadonlySet<string>;
  pluginPreparationErrors?: ReadonlyMap<string, readonly string[]>;
  skills?: readonly RunSkillBinding[];
  agents?: readonly RunAgentBinding[];
  mcpServers?: readonly RunMcpServerBinding[];
  pluginUi?: readonly RunPluginUiBinding[];
}

export class PluginPreparationError extends Error {
  constructor(readonly pluginId: string, readonly reasons: readonly string[]) {
    super(`Plugin ${pluginId} is not ready: ${reasons.join("; ")}`);
    this.name = "PluginPreparationError";
  }
}

export function createRunCapabilityView(sources: RunCapabilitySources, scope?: string | readonly string[]): RunCapabilityView {
  const requested = typeof scope === "string" ? [scope] : scope ?? [];
  const allowed = new Set<string>();
  for (const id of requested) {
    if (!sources.pluginIds?.has(id)) throw new Error(`Plugin is not available in this runtime: ${id}`);
    const errors = sources.pluginPreparationErrors?.get(id);
    if (errors?.length) {
      if (typeof scope === "string") throw new PluginPreparationError(id, errors);
      continue;
    }
    allowed.add(id);
  }
  const pluginId = typeof scope === "string" ? scope : undefined;
  const visible = (binding: { ownerPluginId?: string }) =>
    binding.ownerPluginId === undefined || allowed.has(binding.ownerPluginId);
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
      definitionIdentity: toolDefinitionIdentity(definition),
      // Capture both the function and its original receiver (some tools use WeakMap identity).
      invoke: definition.execute.bind(definition),
    })]);
  }
  const toolMap = readonlyMap(tools);
  const pluginUi = (sources.pluginUi ?? []).filter(binding => allowed.has(binding.pluginId)
    && binding.definition.actions.every(action => {
      const captured = binding.actionTools.find(tool => tool.definition.name === action.tool);
      const current = toolMap.get(action.tool);
      return captured?.source?.kind === "plugin" && captured.source.id === binding.pluginId
        && captured.ownerPluginId === binding.pluginId && current?.source?.kind === "plugin"
        && current.source.id === binding.pluginId && current.ownerPluginId === binding.pluginId && current.definitionIdentity === captured.definitionIdentity
        && current.definition.execute === captured.definition.execute;
    }));
  return Object.freeze({
    pluginId,
    pluginIds: readonlySet(allowed),
    tools: toolMap,
    pluginUi: readonlyMap(pluginUi.map(binding => [`${binding.pluginId}:${binding.componentId}`, frozenCopy(binding)])),
    skills: readonlyMap((sources.skills ?? []).filter(visibleDefinition).map((binding) => [binding.definition.name, frozenCopy(binding)])),
    agents: readonlyMap((sources.agents ?? []).filter(visibleDefinition).map((binding) => [binding.definition.name, frozenCopy(binding)])),
    mcpServers: readonlyMap(servers.filter(visible).map((binding) => [binding.serverId, frozenCopy(binding)])),
  });
}

/** Expose set membership without allowing callers to widen the captured scope. */
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const inner = new Set(values);
  const view: ReadonlySet<T> = Object.freeze({
    size: inner.size,
    has: (value: T) => inner.has(value), keys: () => inner.keys(), values: () => inner.values(),
    entries: () => inner.entries(), [Symbol.iterator]: () => inner[Symbol.iterator](),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) =>
      inner.forEach(value => callback.call(thisArg, value, value, view)),
  });
  return view;
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
