import type { RunCapabilityView, Settings } from "@openharness/core";
import {
  QueryEngine,
  RuntimeBuilder,
  RuntimeBundle,
} from "@openharness/core";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "@openharness/core";
import { CredentialStorage } from "@openharness/auth";
import {
  PermissionChecker,
  LOCAL_READ_ONLY_TOOLS,
  READ_ONLY_TOOLS,
} from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";
import type { SkillRegistry } from "@openharness/skills";
import type { AgentDefinition } from "@openharness/coordinator";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";
import type { OpenHarnessAgentConfiguration } from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "./capability-resolution.js";
import {
  resolveApiClient,
  resolveCustomProviderRuntime,
  resolveRuntimeModel,
  type CustomProviderRuntimeConfig,
} from "./default-runtime-provider.js";
import { attachSandboxRuntime } from "./default-runtime-sandbox.js";
import {
  applyConfiguredTools,
  createVisibilityToolRegistry,
  getInternalToolRegistry,
  type ToolLimit,
} from "./default-runtime-tools.js";

export type { ToolLimit };
export type { CustomProviderRuntimeConfig };
export {
  resolveCustomProviderRuntime,
  resolveRuntimeModel,
};
export { getInternalToolRegistry };

interface OpenHarnessRuntimeOptions {
  settings: Settings;
  cwd?: string;
  configuration: OpenHarnessAgentConfiguration;
  skillRegistry?: SkillRegistry;
  agentDefinitions?: AgentDefinition[];
  credentialStorage?: CredentialStorage;
  sandboxReporter?: SandboxRuntimeReporter;
  sessionId?: string;
  capabilities?: ResolvedAgentCapabilities;
  executionEnvironment?: ExecutionEnvironmentHandle;
}

/**
 * 合并自动放行工具：settings.permission.autoApproveTools（用户显式配置）
 * + autoApproveReadOnly 注入的非本地 READ_ONLY_TOOLS。
 * 本地只读工具(Read/Glob/Grep/Lsp)不在这里隐式注入，交给 PermissionChecker
 * 的 cwd 守卫处理；settings/overrides 显式 autoApproveTools 仍按用户授权保留。
 * 空合并返回 undefined（checker 走默认行为）。
 */
export function resolveAutoApproveTools(
  settings: Settings,
  overrides: { autoApproveReadOnly?: boolean; autoApproveTools?: string[] },
  trustedBuiltinToolNames?: ReadonlySet<string>,
): string[] | undefined {
  const merged = new Set([
    ...(settings.permission.autoApproveTools ?? []),
    ...(overrides.autoApproveTools ?? []),
  ]);
  if (overrides.autoApproveReadOnly) {
    for (const tool of READ_ONLY_TOOLS) {
      if (
        !LOCAL_READ_ONLY_TOOLS.has(tool) &&
        (!trustedBuiltinToolNames || trustedBuiltinToolNames.has(tool))
      ) {
        merged.add(tool);
      }
    }
  }
  return merged.size > 0 ? [...merged] : undefined;
}

export function resolveEffectiveAllowedTools(options: {
  hostToolCeiling?: string[];
  roleAllowedTools?: string[];
  settingsAllowedTools?: string[];
  knownToolNames?: string[];
}): ToolLimit {
  const knownToolNames = options.knownToolNames ?? [];
  const hostCeiling = resolveToolLimit(
    options.hostToolCeiling ?? options.settingsAllowedTools ?? [],
    knownToolNames,
  );
  const roleAllowed = resolveToolLimit(
    options.roleAllowedTools ?? [],
    knownToolNames,
  );
  return intersectToolLimits(hostCeiling, roleAllowed);
}

export async function createOpenHarnessRuntime(
  options: OpenHarnessRuntimeOptions,
): Promise<RuntimeBundle> {
  const { settings } = options;
  const hostCwd = options.cwd ?? process.cwd();
  const cwd = options.executionEnvironment?.workspace.executionRoot ?? hostCwd;
  const configuration = options.configuration;
  const storage = options.credentialStorage ?? new CredentialStorage();

  validateLifecycleToolConfiguration(settings, configuration);

  const apiClient =
    configuration.client ??
    (await resolveApiClient(settings, configuration, storage, options.sessionId));

  const terminal = availableValue(options.capabilities?.terminal);
  const jobs = availableValue(options.capabilities?.jobs);
  const backgroundShell = availableValue(options.capabilities?.backgroundShell);
  const childEnvironment = availableValue(options.capabilities?.childEnvironment);
  const workflowRepository = availableValue(options.capabilities?.workflowRepository);
  const schedules = availableValue(options.capabilities?.schedules);
  const includeBackgroundShell = options.capabilities === undefined
    ? undefined
    : backgroundShell !== undefined && jobs !== undefined;
  const includeDelegation = options.capabilities === undefined
    ? undefined
    : childEnvironment !== undefined && jobs !== undefined;
  const baseToolRegistry = createDefaultToolRegistry({
    environment: options.executionEnvironment,
    schedules: schedules !== undefined,
    terminal: terminal !== undefined,
    jobs: jobs !== undefined,
    backgroundShell: includeBackgroundShell,
    childEnvironment: includeDelegation,
    agentDefinitions: options.agentDefinitions,
    workflowRepository,
  });
  const trustedOverrides = applyConfiguredTools(baseToolRegistry, configuration);
  const trustedBuiltinToolNames = new Set(
    baseToolRegistry.getAll()
      .filter((tool) =>
        baseToolRegistry.inspect(tool.name)?.source.kind === "builtin" ||
        trustedOverrides.has(tool.name)
      )
      .map((tool) => tool.name),
  );

  const knownToolNames = baseToolRegistry.getAll().map((tool) => tool.name);
  const effectiveAllowed = resolveEffectiveAllowedTools({
    hostToolCeiling: configuration.hostToolCeiling,
    roleAllowedTools: configuration.roleAllowedTools,
    settingsAllowedTools: settings.permission.allowedTools,
    knownToolNames,
  });
  const effectiveDenied = new Set(
    normalizeToolNames(
      [
        ...(settings.permission.deniedTools ?? []),
        ...(configuration.disallowedTools ?? []),
      ],
      knownToolNames,
    ),
  );

  const toolRegistry = createVisibilityToolRegistry(
    baseToolRegistry,
    effectiveAllowed,
    effectiveDenied,
    options.executionEnvironment,
  );

  const mode = configuration.permissionMode ?? settings.permission.mode;

  // 自动放行三来源合并:settings.permission.autoApproveTools(用户显式配置,
  // 此前从未接线)+ swarm worker / 无头只读模式注入非本地 READ_ONLY_TOOLS。
  // denied 永远优先于 autoApprove(checker 内保证)。
  const autoApproveTools = resolveAutoApproveTools(
    settings,
    configuration,
    trustedBuiltinToolNames,
  );

  const permissionChecker = new PermissionChecker({
    mode,
    cwd,
    pathStyle: options.executionEnvironment?.info.pathStyle,
    allowedTools:
      effectiveAllowed.kind === "only" ? [...effectiveAllowed.names] : [],
    deniedTools: [...effectiveDenied],
    pathRules: settings.permission.pathRules,
    deniedCommands: settings.permission.deniedCommands,
    autoApproveTools,
    trustedLocalReadOnlyToolNames: [...trustedBuiltinToolNames],
  });

  const hookExecutor = new HookExecutor({
    cwd: options.executionEnvironment?.workspace.executionRoot ?? hostCwd,
    sessionId: options.sessionId,
    settings,
    processExecutor: options.executionEnvironment?.process,
  });
  const runtimeModel = resolveRuntimeModel(settings, configuration);

  // 自定义 prompt 优先。默认提示仅列普通 Skill；有 Run View 时按该次范围重建摘要。
  const buildSystemPrompt = (skillsList: Array<{ name: string; description: string }> | undefined) =>
    buildRuntimeSystemPrompt({
      customPrompt: settings.systemPrompt,
      cwd: hostCwd,
      environmentInfo: options.executionEnvironment?.info,
      permissionMode: mode,
      workStyle: settings.workStyle,
      fastMode: configuration.fastMode ?? settings.fastMode,
      effort: configuration.effort ?? settings.effort,
      passes: settings.passes,
      includeBackgroundShell,
      includeDelegation,
      skillsList,
    });
  const systemPrompt = configuration.systemPrompt ?? await buildSystemPrompt(
    options.skillRegistry?.getNonPluginSkills().filter((skill) => !skill.disableModelInvocation),
  );

  const engineOptions = {
    maxTurns: configuration.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: runtimeModel,
    reasoningEffort: configuration.reasoningEffort,
    cwd,
    sessionId: options.sessionId,
    settings,
    executionEnvironment: options.executionEnvironment,
    skillRegistry: options.skillRegistry,
    systemPromptForRun: async (view: RunCapabilityView) => {
      const prompt = configuration.systemPrompt ?? await buildSystemPrompt(
        [...view.skills.values()].map((binding) => binding.definition).filter((skill) => !skill.disableModelInvocation),
      );
      if (view.agents.size === 0) return prompt;
      const agents = [...view.agents].map(([name, { definition }]) => JSON.stringify({ name, description: definition.description }));
      return `${prompt}\n\n# Available agents\nUse Agent with subagentType set to one of these names:\n${agents.join("\n")}`;
    },
  };

  const queryEngine = new QueryEngine(
    apiClient,
    toolRegistry,
    permissionChecker,
    hookExecutor,
    engineOptions,
  );
  queryEngine.setTerminal(terminal);
  queryEngine.setJobs(jobs);
  queryEngine.setBackgroundShell(backgroundShell);
  queryEngine.setSchedules(schedules);

  const bundle = new RuntimeBuilder()
    .setApiClient(apiClient)
    .setToolRegistry(toolRegistry)
    .setPermissionChecker(permissionChecker)
    .setHookExecutor(hookExecutor)
    .setQueryEngine(queryEngine)
    .build(settings);

  await attachSandboxRuntime(
    bundle,
    hostCwd,
    options.sandboxReporter,
    options.sessionId,
  );
  if (options.executionEnvironment) {
    bundle.addCleanup(() => options.executionEnvironment?.release());
  }
  return bundle;
}

function validateLifecycleToolConfiguration(
  settings: Settings,
  configuration: OpenHarnessAgentConfiguration,
): void {
  const configuredLists: Array<[string, readonly string[] | undefined]> = [
    ["settings.permission.allowedTools", settings.permission.allowedTools],
    ["settings.permission.deniedTools", settings.permission.deniedTools],
    [
      "settings.permission.autoApproveTools",
      settings.permission.autoApproveTools,
    ],
    ["configuration.hostToolCeiling", configuration.hostToolCeiling],
    ["configuration.roleAllowedTools", configuration.roleAllowedTools],
    ["configuration.disallowedTools", configuration.disallowedTools],
    ["configuration.autoApproveTools", configuration.autoApproveTools],
  ];
  for (const [source, tools] of configuredLists) {
    assertNoRemovedLifecycleToolNames(tools ?? [], source);
  }
}

function resolveToolLimit(
  tools: string[],
  knownToolNames: string[],
): ToolLimit {
  const names = resolveAllowedToolNames(tools, knownToolNames);
  return names.length === 0
    ? { kind: "all" }
    : { kind: "only", names: new Set(names) };
}

function intersectToolLimits(left: ToolLimit, right: ToolLimit): ToolLimit {
  if (left.kind === "all") return right;
  if (right.kind === "all") return left;
  const names = [...left.names].filter((tool) => right.names.has(tool));
  return { kind: "only", names: new Set(names) };
}

function availableValue<T>(
  capability: import("./capability-resolution.js").ResolvedCapability<T> | undefined,
): T | undefined {
  return capability?.status === "available" ? capability.value : undefined;
}
