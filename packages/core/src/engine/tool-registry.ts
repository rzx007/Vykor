import type {
  AgentExecutionContext,
  RunToolBinding,
} from "@vykor/agent-contracts";
import type {
  RegisteredToolInspection,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionSpec,
  ToolRegistrationSource,
  MutableToolRegistry as IToolRegistry,
  ToolRegistryView,
} from "@vykor/agent-contracts";

const DEFAULT_TOOL_EXECUTION: Readonly<ToolExecutionSpec> = Object.freeze({
  domain: "environment",
  supportedEnvironments: Object.freeze(["local"]) as Array<"local">,
});

export function resolveToolExecution(tool: ToolDefinition): ToolExecutionSpec {
  return tool.execution ?? DEFAULT_TOOL_EXECUTION;
}

/** Presentation scope only. Malformed explicit metadata never widens either audience. */
export function isToolVisibleTo(
  tool: ToolDefinition,
  audience: "model" | "app",
): boolean {
  if (tool.ui === undefined) return true;
  const visibility = tool.ui?.visibility;
  return (
    Array.isArray(visibility) &&
    visibility.length > 0 &&
    visibility.every((value) => value === "model" || value === "app") &&
    visibility.includes(audience)
  );
}

function audienceToolRegistry(
  inner: IToolRegistry,
  audience: "model" | "app",
): IToolRegistry {
  const get = (name: string) => {
    const tool = inner.get(name);
    return tool && isToolVisibleTo(tool, audience) ? tool : undefined;
  };
  return {
    register: (tool, source) => inner.register(tool, source),
    override: (tool, source) => inner.override(tool, source),
    replaceBySource: (source, tools) => inner.replaceBySource(source, tools),
    unregister: (name) => inner.unregister?.(name) ?? false,
    get,
    getAll: () =>
      inner.getAll().filter((tool) => isToolVisibleTo(tool, audience)),
    has: (name) => get(name) !== undefined,
    inspect: (name) => (get(name) ? inner.inspect(name) : undefined),
  };
}

export function modelToolRegistry(inner: IToolRegistry): IToolRegistry {
  return audienceToolRegistry(inner, "model");
}

type ToolRegistrationErrorCode =
  "tool_already_registered" | "tool_override_target_not_found";

interface ToolEntry {
  definition: ToolDefinition;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}

export class ToolRegistrationError extends Error {
  constructor(
    readonly code: ToolRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistrationError";
  }
}

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ToolEntry>();

  register(
    tool: ToolDefinition,
    source: ToolRegistrationSource = { kind: "runtime" },
  ): void {
    const existing = this.tools.get(tool.name);
    if (existing) {
      throw new ToolRegistrationError(
        "tool_already_registered",
        `Tool "${tool.name}" is already registered by ${formatSource(existing.source)}; use an explicit override`,
      );
    }
    this.tools.set(tool.name, { definition: tool, source: copySource(source) });
  }

  override(tool: ToolDefinition, source: ToolRegistrationSource): void {
    const existing = this.tools.get(tool.name);
    if (!existing) {
      throw new ToolRegistrationError(
        "tool_override_target_not_found",
        `Cannot override unknown Tool "${tool.name}"`,
      );
    }
    this.tools.set(tool.name, {
      definition: tool,
      source: copySource(source),
      overrides: copySource(existing.source),
    });
  }

  replaceBySource(
    source: ToolRegistrationSource,
    tools: ToolDefinition[],
  ): void {
    const next = new Map(this.tools);
    for (const [name, entry] of next) {
      if (sameSource(entry.source, source)) next.delete(name);
    }
    const claimed = new Set<string>();
    for (const tool of tools) {
      if (claimed.has(tool.name)) {
        throw new ToolRegistrationError(
          "tool_already_registered",
          `Tool "${tool.name}" is already registered by ${formatSource(source)}; use an explicit override`,
        );
      }
      const existing = next.get(tool.name);
      if (existing) {
        throw new ToolRegistrationError(
          "tool_already_registered",
          `Tool "${tool.name}" is already registered by ${formatSource(existing.source)}; use an explicit override`,
        );
      }
      claimed.add(tool.name);
    }
    for (const tool of tools) {
      next.set(tool.name, { definition: tool, source: copySource(source) });
    }
    this.tools = next;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values(), (entry) => entry.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  inspect(name: string): RegisteredToolInspection | undefined {
    const entry = this.tools.get(name);
    if (!entry) return undefined;
    return {
      name,
      source: copySource(entry.source),
      ...(entry.overrides ? { overrides: copySource(entry.overrides) } : {}),
    };
  }
}

function copySource(source: ToolRegistrationSource): ToolRegistrationSource {
  return Object.freeze({
    kind: source.kind,
    ...(source.id === undefined ? {} : { id: source.id }),
  });
}

function formatSource(source: ToolRegistrationSource): string {
  return source.id ? `${source.kind}:${source.id}` : source.kind;
}

function sameSource(
  a: ToolRegistrationSource,
  b: ToolRegistrationSource,
): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Apply authorization rules: null or a grant of "*" retains the full inner registry. */
export function visibleToolRegistry(
  inner: IToolRegistry,
  allowedTools: readonly string[] | null,
  alwaysAllowed: readonly string[] = [],
): IToolRegistry {
  if (!allowedTools || allowedTools.includes("*")) return inner;
  return toolRegistryForNames(inner, [...allowedTools, ...alwaysAllowed]);
}

/** Filter by actual names, including a literal "*". Never expands the inner scope. */
export function toolRegistryForNames(
  inner: IToolRegistry,
  names: Iterable<string>,
): IToolRegistry {
  const allowed = new Set(names);
  return {
    register(tool: ToolDefinition, source): void {
      inner.register(tool, source);
    },
    override(tool: ToolDefinition, source): void {
      inner.override(tool, source);
    },
    replaceBySource(
      source: ToolRegistrationSource,
      tools: ToolDefinition[],
    ): void {
      inner.replaceBySource(source, tools);
    },
    unregister(name: string): boolean {
      return inner.unregister?.(name) ?? false;
    },
    get(name: string): ToolDefinition | undefined {
      return allowed.has(name) ? inner.get(name) : undefined;
    },
    getAll(): ToolDefinition[] {
      return inner.getAll().filter((tool) => allowed.has(tool.name));
    },
    has(name: string): boolean {
      return allowed.has(name) && inner.has(name);
    },
    inspect(name: string) {
      return allowed.has(name) ? inner.inspect(name) : undefined;
    },
  };
}

export function runToolRegistry(
  inner: IToolRegistry,
  allowedTools: readonly string[] | null,
  contribution: AgentExecutionContext["contribution"],
  bindings?: ReadonlyMap<string, RunToolBinding>,
): IToolRegistry {
  const base = bindings
    ? capturedToolRegistry(bindings)
    : visibleToolRegistry(inner, allowedTools);
  const contributed = contribution?.tools ?? [];
  if (contributed.length === 0) return modelToolRegistry(base);
  const additions = new Map<string, ToolDefinition>();
  for (const { definition } of contributed) {
    if (base.has(definition.name) || additions.has(definition.name))
      throw new Error(
        `Run tool conflicts with an existing tool: ${definition.name}`,
      );
    additions.set(definition.name, definition);
  }
  return modelToolRegistry({
    register: () => {
      throw new Error("Run-scoped tool registry is immutable");
    },
    override: () => {
      throw new Error("Run-scoped tool registry is immutable");
    },
    replaceBySource: () => {
      throw new Error("Run-scoped tool registry is immutable");
    },
    unregister: () => false,
    get: (name) => additions.get(name) ?? base.get(name),
    getAll: () => [...base.getAll(), ...additions.values()],
    has: (name) => additions.has(name) || base.has(name),
    inspect: (name) =>
      additions.has(name)
        ? { name, source: { kind: "runtime", id: "run-contribution" } }
        : base.inspect(name),
  });
}

/** Executes exactly the bindings captured by a trusted caller; never consults a second directory. */
export function capturedToolRegistry(
  bindings: ReadonlyMap<string, RunToolBinding>,
): IToolRegistry {
  const captured = new Map(
    [...bindings].map(([name, binding]) => [
      name,
      { ...binding.definition, execute: binding.invoke },
    ]),
  );
  return {
    register: () => {
      throw new Error("Captured tools are immutable");
    },
    override: () => {
      throw new Error("Captured tools are immutable");
    },
    replaceBySource: () => {
      throw new Error("Captured tools are immutable");
    },
    get: (name) => captured.get(name),
    getAll: () => [...captured.values()],
    has: (name) => captured.has(name),
    inspect: (name) => {
      const binding = bindings.get(name);
      return binding
        ? { name, source: binding.source ?? { kind: "runtime" } }
        : undefined;
    },
  };
}

export function toolRegistryView(registry: IToolRegistry): ToolRegistryView {
  return {
    get: (name) => {
      const tool = registry.get(name);
      return tool ? toolDescriptor(tool) : undefined;
    },
    getAll: () => registry.getAll().map(toolDescriptor),
    has: (name) => registry.has(name),
    inspect: (name) => registry.inspect(name),
  };
}

function toolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: deepFrozenCopy(tool.inputSchema),
    ...(tool.ui ? { ui: deepFrozenCopy(tool.ui) } : {}),
    ...(tool.annotations
      ? { annotations: deepFrozenCopy(tool.annotations) }
      : {}),
    ...(tool.safeToRetry === undefined
      ? {}
      : { safeToRetry: tool.safeToRetry }),
  });
}

function deepFrozenCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFrozenCopy(item))) as T;
  }
  if (value && typeof value === "object") {
    const copied = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        deepFrozenCopy(item),
      ]),
    );
    return Object.freeze(copied) as T;
  }
  return value;
}
