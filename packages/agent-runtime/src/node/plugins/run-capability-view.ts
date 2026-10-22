import { readonlyMap, readonlySet } from "@vykor/agent-contracts";
export { readonlyMap, readonlySet } from "@vykor/agent-contracts";
import {
  type RunAgentBinding,
  type RunCapabilityView,
  type RunMcpServerBinding,
  type RunSkillBinding,
} from "../runtime/node-runtime-resources.js";
import { type NodeRunToolBinding as RunToolBinding } from "../runtime/node-runtime-resources.js";
import type { MutableToolRegistry as IToolRegistry } from "@vykor/agent-contracts";
import { toolDefinitionIdentity } from "@vykor/core";
import { isToolVisibleTo } from "@vykor/core";

export interface RunCapabilitySources {
  toolRegistry: IToolRegistry;
  /** Already restricted by the same role/host/deny/environment policy, before model hiding. */
  appToolRegistry?: IToolRegistry;
  /** Same host permissions and environment, without the current role's tool limit. */
  delegatableToolRegistry?: IToolRegistry;
  pluginIds?: ReadonlySet<string>;
  pluginPreparationErrors?: ReadonlyMap<string, readonly string[]>;
  skills?: readonly RunSkillBinding[];
  agents?: readonly RunAgentBinding[];
  mcpServers?: readonly RunMcpServerBinding[];
  mcpAuthServers?: readonly RunMcpServerBinding[];
}

export class PluginPreparationError extends Error {
  constructor(
    readonly pluginId: string,
    readonly reasons: readonly string[],
  ) {
    super(`Plugin ${pluginId} is not ready: ${reasons.join("; ")}`);
    this.name = "PluginPreparationError";
  }
}

export function createRunCapabilityView(
  sources: RunCapabilitySources,
  scope?: string | readonly string[],
): RunCapabilityView {
  const requested = typeof scope === "string" ? [scope] : (scope ?? []);
  const allowed = new Set<string>();
  for (const id of requested) {
    if (!sources.pluginIds?.has(id))
      throw new Error(`Plugin is not available in this runtime: ${id}`);
    const errors = sources.pluginPreparationErrors?.get(id);
    if (errors?.length) {
      if (typeof scope === "string")
        throw new PluginPreparationError(id, errors);
      continue;
    }
    allowed.add(id);
  }
  const pluginId = typeof scope === "string" ? scope : undefined;
  const visible = (binding: { ownerPluginId?: string }) =>
    binding.ownerPluginId === undefined || allowed.has(binding.ownerPluginId);
  const visibleDefinition = (binding: RunSkillBinding | RunAgentBinding) =>
    !(binding.definition.source === "plugin" && !binding.ownerPluginId) &&
    visible(binding);
  const servers = sources.mcpServers ?? [];
  const byServerName = new Map(
    servers.map((server) => [server.serverName, server]),
  );
  if (byServerName.size !== servers.length) {
    const ambiguous = servers.find(
      (server, index) =>
        servers.findIndex((other) => other.serverName === server.serverName) !==
        index,
    )!;
    throw new Error(`Ambiguous MCP server name: ${ambiguous.serverName}`);
  }
  const captureTools = (
    registry: IToolRegistry,
    audience: "model" | "app" = "model",
  ): Array<[string, RunToolBinding]> => {
    const tools: Array<[string, RunToolBinding]> = [];
    for (const definition of registry.getAll()) {
      if (!isToolVisibleTo(definition, audience)) continue;
      const source = registry.inspect(definition.name)?.source;
      const server =
        source?.kind === "mcp" && source.id
          ? byServerName.get(source.id)
          : undefined;
      if (source?.kind === "mcp" && !server) continue;
      const ownerPluginId =
        source?.kind === "plugin" ? source.id : server?.ownerPluginId;
      // A plugin registration without its owner cannot become a baseline capability.
      if (source?.kind === "plugin" && !ownerPluginId) continue;
      if (!visible({ ownerPluginId })) continue;
      tools.push([
        definition.name,
        frozenCopy({
          ownerPluginId,
          definition,
          source,
          serverId: server?.serverId,
          definitionIdentity: toolDefinitionIdentity(definition),
          // Capture both the function and its original receiver (some tools use WeakMap identity).
          invoke: definition.execute.bind(definition),
        }),
      ]);
    }
    return tools;
  };
  const tools = captureTools(sources.toolRegistry);
  const appTools = readonlyMap(
    captureTools(sources.appToolRegistry ?? sources.toolRegistry, "app"),
  );
  const delegatableTools = sources.delegatableToolRegistry
    ? readonlyMap(captureTools(sources.delegatableToolRegistry))
    : undefined;
  const toolMap = readonlyMap(tools);
  return Object.freeze({
    pluginId,
    pluginIds: readonlySet(allowed),
    tools: toolMap,
    appTools,
    ...(delegatableTools ? { delegatableTools } : {}),
    skills: readonlyMap(
      (sources.skills ?? [])
        .filter(visibleDefinition)
        .map((binding) => [binding.definition.name, frozenCopy(binding)]),
    ),
    agents: readonlyMap(
      (sources.agents ?? [])
        .filter(visibleDefinition)
        .map((binding) => [binding.definition.name, frozenCopy(binding)]),
    ),
    mcpAuthServers: readonlyMap(
      (sources.mcpAuthServers ?? servers)
        .filter(visible)
        .map((binding) => [binding.serverId, frozenCopy(binding)]),
    ),
    mcpServers: readonlyMap(
      servers
        .filter(visible)
        .map((binding) => [binding.serverId, frozenCopy(binding)]),
    ),
  });
}

/** Keep executable/delegatable tools and their UI bindings under one narrowing operation. */
export function restrictRunCapabilityView(
  view: RunCapabilityView,
  permitsTool: (name: string, binding: RunToolBinding) => boolean,
  permitsDelegation = permitsTool,
): RunCapabilityView {
  const filter = (
    bindings: ReadonlyMap<string, RunToolBinding>,
    permits: typeof permitsTool,
  ) =>
    readonlyMap(
      [...bindings].filter(
        ([name, binding]) =>
          (!binding.serverId || view.mcpServers.has(binding.serverId)) &&
          permits(name, binding),
      ),
    );
  const tools = filter(view.tools, permitsTool);
  const delegatableTools =
    view.delegatableTools && filter(view.delegatableTools, permitsDelegation);
  return Object.freeze({
    ...view,
    tools,
    ...(view.appTools ? { appTools: filter(view.appTools, permitsTool) } : {}),
    ...(delegatableTools ? { delegatableTools } : {}),
  });
}

function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, frozenCopy(item)]),
      ),
    ) as T;
  }
  return value;
}

/** Object.freeze(Map) still permits set/delete; expose only read operations. */
