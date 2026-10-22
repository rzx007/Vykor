import type { QueryEngineOptions } from "../types/runtime.js";
import type { RunToolBinding } from "@vykor/agent-contracts";
import type { ToolDiscovery, ToolDiscoveryEntry, MutableToolRegistry as ToolRegistry } from "@vykor/agent-contracts";
import { toolDefinitionIdentity } from "./tool-definition-identity.js";
import { modelToolRegistry, toolRegistryForNames } from "./tool-registry.js";

/** One submitMessage lifetime. Authorization and captured bindings stay in the original registry. */
export class RunToolDiscovery implements ToolDiscovery {
  readonly catalog: readonly ToolDiscoveryEntry[];
  private readonly exposed: Set<string>;
  private eligible: ReadonlySet<string>;

  private constructor(
    private readonly registry: ToolRegistry,
    readonly searchToolName: string,
    deferred: ReadonlySet<string>,
  ) {
    this.catalog = Object.freeze(registry.getAll().map(tool => {
      const source = registry.inspect(tool.name)?.source;
      return Object.freeze({ name: tool.name, description: tool.description.slice(0, 1000),
        ...(source ? { source: Object.freeze({ ...source }) } : {}),
      });
    }));
    this.eligible = new Set(this.catalog.map(row => row.name));
    this.exposed = new Set(this.catalog.filter(row => !deferred.has(row.name)).map(row => row.name));
  }

  static create(registry: ToolRegistry, policy?: QueryEngineOptions["toolDiscovery"], bindings?: ReadonlyMap<string, RunToolBinding>): RunToolDiscovery | undefined {
    if (!policy) return undefined;
    registry = modelToolRegistry(registry);
    const search = registry.get(policy.searchTool.name);
    const binding = bindings?.get(policy.searchTool.name);
    // Same-name replacements must not strand deferred tools behind an unrelated search tool.
    if (!search || registry.inspect(search.name)?.source.kind !== "builtin"
      || (bindings ? binding?.definitionIdentity !== toolDefinitionIdentity(policy.searchTool)
        || binding.definition.execute !== policy.searchTool.execute
        : toolDefinitionIdentity(search) !== toolDefinitionIdentity(policy.searchTool) || search.execute !== policy.searchTool.execute)) return undefined;
    const deferred = registry.getAll().filter(tool => tool.name !== search.name && policy.shouldDefer(tool, registry.inspect(tool.name)?.source));
    const bytes = Buffer.byteLength(JSON.stringify(deferred.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
    if (!deferred.length || (deferred.length < (policy.minToolCount ?? 20) && bytes < (policy.minSchemaBytes ?? 32_768))) return undefined;
    return new RunToolDiscovery(registry, search.name, new Set(deferred.map(tool => tool.name)));
  }

  getEligibleNames(): ReadonlySet<string> { return new Set(this.eligible); }

  expose(names: readonly string[]): readonly string[] {
    const accepted = [...new Set(names)].filter(name => this.eligible.has(name) && this.registry.has(name)).slice(0, 20);
    for (const name of accepted) this.exposed.add(name);
    return accepted;
  }

  /** Freeze each request before sampling, including the entire returned tool batch. */
  requestRegistry(hidden: readonly string[], forcedFinal: boolean): ToolRegistry {
    const excluded = new Set(hidden);
    this.eligible = new Set(this.catalog.filter(row => !forcedFinal && !excluded.has(row.name) && this.registry.has(row.name)).map(row => row.name));
    return toolRegistryForNames(this.registry, [...this.exposed].filter(name => this.eligible.has(name)));
  }
}
