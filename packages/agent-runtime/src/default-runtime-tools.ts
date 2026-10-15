import type { IToolRegistry, ToolDefinition } from "@vykor/core";
import { resolveToolExecution, ToolRegistrationError } from "@vykor/core";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";

import type { VykorAgentConfiguration } from "./agent-options.js";
import { GOAL_UPDATE_TOOL_NAME } from "./goal-update-tool.js";
import { GOAL_READ_TOOL_NAME } from "./goal-read-tool.js";

export type ToolLimit =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "only"; names: ReadonlySet<string> };

export function applyConfiguredTools(
  registry: IToolRegistry,
  configuration: VykorAgentConfiguration,
): Set<string> {
  const additions = configuration.tools ?? [];
  const overrides = configuration.toolOverrides ?? [];
  const trustedOverrides = new Set(configuration.trustedToolOverrides ?? []);
  const additionNames = assertUniqueToolNames(additions, "tools");
  const overrideNames = assertUniqueToolNames(overrides, "toolOverrides");
  for (const name of [GOAL_UPDATE_TOOL_NAME, GOAL_READ_TOOL_NAME]) {
    if (additionNames.has(name) || overrideNames.has(name)) {
      throw new ToolRegistrationError("tool_already_registered", `${name} is reserved for durable goal runs`);
    }
  }

  for (const name of trustedOverrides) {
    if (!overrideNames.has(name)) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must also appear in toolOverrides`,
      );
    }
  }

  for (const name of additionNames) {
    if (overrideNames.has(name)) {
      throw new Error(
        `Tool "${name}" cannot appear in both tools and toolOverrides`,
      );
    }
    if (registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_already_registered",
        `Tool "${name}" is already registered by builtin; use toolOverrides`,
      );
    }
  }
  for (const name of overrideNames) {
    if (!registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_override_target_not_found",
        `Tool override target "${name}" is not registered`,
      );
    }
    if (
      trustedOverrides.has(name) &&
      registry.inspect(name)?.source.kind !== "builtin"
    ) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must replace a builtin Tool`,
      );
    }
  }

  for (const tool of additions) registry.register(tool, { kind: "agent" });
  for (const tool of overrides) registry.override(tool, { kind: "agent" });
  return trustedOverrides;
}

function assertUniqueToolNames(
  tools: readonly ToolDefinition[],
  field: "tools" | "toolOverrides",
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate Tool "${tool.name}" in ${field}`);
    }
    names.add(tool.name);
  }
  return names;
}

export function createVisibilityToolRegistry(
  inner: IToolRegistry,
  allowedTools: ToolLimit,
  deniedTools: ReadonlySet<string>,
  environment?: ExecutionEnvironmentHandle,
): IToolRegistry {
  return new RuntimeToolRegistry(inner, allowedTools, deniedTools, environment);
}

class RuntimeToolRegistry implements IToolRegistry {
  constructor(
    private readonly inner: IToolRegistry,
    private readonly allowedTools: ToolLimit,
    private readonly deniedTools: ReadonlySet<string>,
    private readonly environment?: ExecutionEnvironmentHandle,
  ) {}

  register(tool: ToolDefinition, source?: Parameters<IToolRegistry["register"]>[1]): void {
    this.inner.register(tool, source);
  }

  override(tool: ToolDefinition, source: Parameters<IToolRegistry["override"]>[1]): void {
    this.inner.override(tool, source);
  }

  replaceBySource(
    source: Parameters<IToolRegistry["replaceBySource"]>[0],
    tools: Parameters<IToolRegistry["replaceBySource"]>[1],
  ): void {
    this.inner.replaceBySource(source, tools);
  }

  unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.inner.get(name);
    return tool && this.isVisible(tool) ? tool : undefined;
  }

  getAll(): ToolDefinition[] {
    return this.inner.getAll().filter((tool) => this.isVisible(tool));
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  inspect(name: string) {
    const tool = this.inner.get(name);
    return tool && this.isVisible(tool) ? this.inner.inspect(name) : undefined;
  }

  internalRegistry(): IToolRegistry {
    return this.inner;
  }

  private isVisible(tool: ToolDefinition): boolean {
    if (this.allowedTools.kind === "none") return false;
    if (this.deniedTools.has(tool.name)) return false;
    const execution = resolveToolExecution(tool);
    const environmentKind = this.environment?.info.kind ?? "local";
    if (!(execution.supportedEnvironments ?? ["local"]).includes(environmentKind)) return false;
    if (execution.network && this.environment?.info.networkMode === "none") return false;
    return (
      this.allowedTools.kind === "all" || this.allowedTools.names.has(tool.name)
    );
  }
}

export function getInternalToolRegistry(registry: IToolRegistry): IToolRegistry {
  return registry instanceof RuntimeToolRegistry
    ? registry.internalRegistry()
    : registry;
}
