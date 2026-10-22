import { NodeRunCatalogue } from "../capabilities/node-run-catalogue.js";
import type {
  AgentChildSpawnInput,
  AgentModelConfiguration,
  AgentRunScope,
  RunToolBinding,
} from "@vykor/agent-contracts";
import {
  AgentChildManager,
  type AgentChildManagerOptions as KernelOptions,
} from "../../kernel/child-agent.js";
import { resolveChildBudget } from "../../kernel/child-registry.js";
import type { Settings } from "@vykor/host-config";
import type { VykorAgentOptions, DefaultNodeAgent } from "./agent.js";
import type {
  VykorAgentConfiguration,
  AgentCapabilityOverrides,
  AgentEffectOverrides,
} from "./agent-options.js";
import {
  deriveChildAgentOptions,
  deriveChildCapabilityView,
  resolveChildMaxTurns,
} from "./child-agent-options.js";
import { isDeepStrictEqual } from "node:util";
import type { RunCapabilityView } from "./node-runtime-resources.js";
import { readonlyMap } from "@vykor/agent-contracts";
export interface NodeChildManagerOptions extends Omit<
  KernelOptions,
  "budget" | "resolveChild"
> {
  runCatalogue?: NodeRunCatalogue;
  settings: Settings;
  configuration: VykorAgentConfiguration;
  configurationForChild?: () => VykorAgentConfiguration;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  createAgent(
    options: VykorAgentOptions,
    identity: {
      childId: string;
      parentSessionId: string;
      parentRunId: string;
    },
  ): Promise<DefaultNodeAgent>;
}
export class NodeChildManager extends AgentChildManager {
  readonly runCatalogue: NodeRunCatalogue;
  private readonly childCatalogues: Map<string, RunCapabilityView>;
  override createController(
    scope: Parameters<AgentChildManager["createController"]>[0],
    tools?: ReadonlyMap<string, RunToolBinding> | RunCapabilityView,
  ) {
    if (tools && "tools" in tools) {
      const captured = readonlyMap([
        ...(tools.delegatableTools ?? []),
        ...tools.tools,
      ]);
      this.runCatalogue.register({ ...tools, tools: captured });
      return super.createController(scope, captured);
    }
    return super.createController(scope, tools);
  }
  override send(
    id: string,
    input: import("@vykor/agent-contracts").AgentChildInput,
    tools?: ReadonlyMap<string, RunToolBinding> | RunCapabilityView,
    parent:
      import("../../kernel/child-agent.js").TrustedChildRunParent | null = null,
  ) {
    const captured = this.childCatalogues.get(id);
    const authorization =
      tools && "tools" in tools ? tools : this.runCatalogue.resolveView(tools);
    if (captured && !authorizesNodeView(captured, authorization))
      return Promise.reject(
        new Error("Child tools are not authorized for this Run."),
      );
    return super.send(
      id,
      input,
      tools && "tools" in tools
        ? readonlyMap([...(tools.delegatableTools ?? []), ...tools.tools])
        : tools,
      parent,
    );
  }
  override spawnSystemChild(
    scope: Parameters<AgentChildManager["spawnSystemChild"]>[0],
    input: AgentChildSpawnInput,
    content: string,
    tools?: ReadonlyMap<string, RunToolBinding> | RunCapabilityView,
  ) {
    if (tools && "tools" in tools) {
      this.runCatalogue.register(tools);
      return super.spawnSystemChild(scope, input, content, tools.tools);
    }
    return super.spawnSystemChild(scope, input, content, tools);
  }
  constructor(options: NodeChildManagerOptions) {
    const childCatalogues = new Map<string, RunCapabilityView>();
    const runCatalogue = options.runCatalogue ?? new NodeRunCatalogue();
    super({
      ...options,
      budget: resolveChildBudget(
        options.settings.childBudget,
        options.configuration.childBudget,
      ),
      resolveChild: (input) => {
        const configuration =
          options.configurationForChild?.() ?? options.configuration;
        const { requestConfigurationStoreForSession, ...inherited } =
          configuration;
        const resolved = deriveChildAgentOptions({
          configuration: inherited,
          settings: options.settings,
          capabilityOverrides: options.capabilityOverrides,
          effects: options.effects,
          child: input.spawn,
          cwd: input.lease.cwd,
          sessionId: input.sessionId,
          ...(input.system ? { internalTextOnly: true } : {}),
        });
        const spawn = {
          ...input.spawn,
          approvalMode: resolved.approvalMode,
          workMode: resolved.workMode,
          permissionMode:
            resolved.permissionMode === "plan"
              ? ("plan" as const)
              : resolved.permissionMode === "full_auto" ||
                  resolved.permissionMode === "full_access"
                ? ("full_auto" as const)
                : ("default" as const),
        };
        const captured = runCatalogue.resolveView(input.tools);
        if (captured)
          childCatalogues.set(
            input.childId,
            deriveChildCapabilityView(captured, spawn)!,
          );
        const capturedCandidates = runCatalogue.resolveCandidates(input.tools);
        const parentRequestConfiguration = configuration.model
          ? {
              model: configuration.model,
              provider: configuration.provider,
              baseUrl: configuration.baseUrl,
              apiFormat: configuration.apiFormat,
              effort: configuration.effort,
            }
          : undefined;
        return {
          spawn,
          parentRequestConfiguration,
          hardMaxTurns: () =>
            resolveChildMaxTurns({
              roleMaxTurns: spawn.maxTurns,
              requestedMaxTurns: spawn.requestedMaxTurns,
              requestConfigurationMaxTurns: (
                options.configurationForChild?.() ?? options.configuration
              ).maxTurns,
              settingsMaxTurns: options.settings.maxTurns,
            }),
          createAgent: async () => {
            const agent = await options.createAgent(
              {
                ...resolved,
                requestConfigurationStoreForSession,
                requestConfigurationStore:
                  requestConfigurationStoreForSession?.(input.sessionId),
              },
              {
                childId: input.childId,
                parentSessionId: input.parentScope.sessionId,
                parentRunId: input.parentScope.runId,
              },
            );
            const submit = agent.submitMessage.bind(agent);
            agent.submitMessage = (content, run = {}) => {
              const baseline = agent.host.plugins.createRunCapabilityView();
              const inherited =
                captured && baseline
                  ? bindChildRuntime(captured, baseline)
                  : captured;
              return submit(content, {
                ...run,
                ...(inherited
                  ? {
                      capabilityView: deriveChildCapabilityView(
                        inherited,
                        spawn,
                      ),
                      pluginCandidates: capturedCandidates,
                    }
                  : {}),
              });
            };
            return agent;
          },
        };
      },
    });
    this.childCatalogues = childCatalogues;
    this.runCatalogue = runCatalogue;
  }
}
/** Child-local builtin closures retain the parent's explicit execution ceiling; plugin closures remain original. */
function bindChildRuntime(
  inherited: RunCapabilityView,
  baseline: RunCapabilityView,
): RunCapabilityView {
  const tools = readonlyMap(
    [...inherited.tools].flatMap(([name, binding]) => {
      if (
        binding.ownerPluginId !== undefined ||
        binding.source?.kind === "plugin" ||
        binding.source?.kind === "mcp"
      )
        return [[name, binding] as const];
      const local = baseline.tools.get(name);
      return local &&
        isDeepStrictEqual(local.source, binding.source) &&
        isDeepStrictEqual(
          local.definition.execution,
          binding.definition.execution,
        ) &&
        isDeepStrictEqual(
          local.definition.inputSchema,
          binding.definition.inputSchema,
        )
        ? [[name, Object.freeze({ ...binding, invoke: local.invoke })] as const]
        : [];
    }),
  );
  const merge = <
    T extends {
      ownerPluginId?: string;
    },
  >(
    local: ReadonlyMap<string, T>,
    captured: ReadonlyMap<string, T>,
  ) =>
    readonlyMap(
      [...local]
        .filter(([, binding]) => binding.ownerPluginId === undefined)
        .concat(
          [...captured].filter(
            ([, binding]) => binding.ownerPluginId !== undefined,
          ),
        ),
    );
  return Object.freeze({
    ...inherited,
    tools,
    skills: merge(baseline.skills, inherited.skills),
    agents: merge(baseline.agents, inherited.agents),
  });
}
function authorizesNodeView(
  child: RunCapabilityView,
  parent?: RunCapabilityView,
): boolean {
  const owners =
    child.pluginIds ?? new Set(child.pluginId ? [child.pluginId] : []);
  const allowed =
    parent?.pluginIds ?? new Set(parent?.pluginId ? [parent.pluginId] : []);
  for (const owner of owners) if (!allowed.has(owner)) return false;
  for (const [name, binding] of [
    ...child.tools,
    ...(child.delegatableTools ?? []),
  ]) {
    if (binding.ownerPluginId === undefined) continue;
    const current =
      parent?.delegatableTools?.get(name) ?? parent?.tools.get(name);
    if (
      !current ||
      current.ownerPluginId !== binding.ownerPluginId ||
      current.serverId !== binding.serverId ||
      current.definitionIdentity !== binding.definitionIdentity ||
      current.definition.execute !== binding.definition.execute ||
      !isDeepStrictEqual(current.source, binding.source)
    )
      return false;
  }
  for (const kind of [
    "skills",
    "agents",
    "mcpServers",
    "mcpAuthServers",
  ] as const)
    for (const [name, binding] of child[kind] ?? [])
      if (
        binding.ownerPluginId !== undefined &&
        !isDeepStrictEqual(parent?.[kind]?.get(name), binding)
      )
        return false;
  return true;
}
