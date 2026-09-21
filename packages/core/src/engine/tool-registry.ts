import type {
  RegisteredToolInspection,
  ToolDefinition,
  ToolExecutionSpec,
  ToolRegistrationSource,
  ToolRegistry as IToolRegistry,
} from "../index";

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
