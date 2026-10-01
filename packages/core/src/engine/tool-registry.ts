import type { AgentExecutionContext } from "../index";
import type {
  RegisteredToolInspection,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionSpec,
  ToolRegistrationSource,
  ToolRegistry as IToolRegistry,
  ToolRegistryView,
} from "../types/tools";

const DEFAULT_TOOL_EXECUTION: Readonly<ToolExecutionSpec> = Object.freeze({
  domain: "environment",
  supportedEnvironments: Object.freeze(["local"]) as Array<"local">,
});

export function resolveToolExecution(tool: ToolDefinition): ToolExecutionSpec {
  return tool.execution ?? DEFAULT_TOOL_EXECUTION;
}

type ToolRegistrationErrorCode =
  | "tool_already_registered"
  | "tool_override_target_not_found";

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

  replaceBySource(source: ToolRegistrationSource, tools: ToolDefinition[]): void {
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

function sameSource(a: ToolRegistrationSource, b: ToolRegistrationSource): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function visibleToolRegistry(
  inner: IToolRegistry,
  allowedTools: readonly string[] | null,
  alwaysAllowed: readonly string[] = [],
): IToolRegistry {
  if (!allowedTools || allowedTools.includes("*")) return inner;
  const allowed = new Set([...allowedTools, ...alwaysAllowed]);
  return {
    register(tool: ToolDefinition, source): void {
      inner.register(tool, source);
    },
    override(tool: ToolDefinition, source): void {
      inner.override(tool, source);
    },
    replaceBySource(source: ToolRegistrationSource, tools: ToolDefinition[]): void {
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
  view?: AgentExecutionContext["capabilityView"],
): IToolRegistry {
  const captured = view && new Map([...view.tools].map(([name, binding]) => [
    name, { ...binding.definition, execute: binding.invoke },
  ]));
  const base: IToolRegistry = captured ? {
    register: () => { throw new Error("Run capability view is immutable"); },
    override: () => { throw new Error("Run capability view is immutable"); },
    replaceBySource: () => { throw new Error("Run capability view is immutable"); },
    get: (name) => captured.get(name),
    getAll: () => [...captured.values()],
    has: (name) => captured.has(name),
    inspect: (name) => {
      const binding = view!.tools.get(name);
      return binding ? { name, source: binding.source ?? { kind: "runtime" } } : undefined;
    },
  } : visibleToolRegistry(inner, allowedTools);
  const contributed = contribution?.tools ?? [];
  if (contributed.length === 0) return base;
  const additions = new Map<string, ToolDefinition>();
  for (const { definition } of contributed) {
    if (base.has(definition.name) || additions.has(definition.name))
      throw new Error(`Run tool conflicts with an existing tool: ${definition.name}`);
    additions.set(definition.name, definition);
  }
  return {
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
    ...(tool.safeToRetry === undefined ? {} : { safeToRetry: tool.safeToRetry }),
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
