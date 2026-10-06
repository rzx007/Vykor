import type { AgentRequestConfigurationReader, RunCapabilityView, Settings, StreamingMessageClient, ToolDefinition } from "@vykor/core";
import {
  DEFAULT_OUTPUT_TOKEN_MAX,
  QueryEngine,
  RuntimeBuilder,
  RuntimeBundle,
  resolveOutputTokenCap,
} from "@vykor/core";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "@vykor/core";
import { CredentialStorage } from "@vykor/auth";
import {
  PermissionChecker,
  LOCAL_READ_ONLY_TOOLS,
  READ_ONLY_TOOLS,
} from "@vykor/permissions";
import { HookExecutor } from "@vykor/hooks";
import { createDefaultToolRegistry, createShellOutputLogHost } from "@vykor/tools";
import { buildRuntimeSystemPrompt } from "@vykor/prompts";
import type { SandboxRuntimeReporter } from "@vykor/sandbox";
import type { SkillRegistry } from "@vykor/skills";
import type { AgentDefinition } from "@vykor/coordinator";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import type { VykorAgentConfiguration } from "./agent-options.js";
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

interface VykorRuntimeOptions {
  settings: Settings;
  cwd?: string;
  configuration: VykorAgentConfiguration;
  skillRegistry?: SkillRegistry;
  agentDefinitions?: AgentDefinition[];
  credentialStorage?: CredentialStorage;
  sandboxReporter?: SandboxRuntimeReporter;
  sessionId?: string;
  capabilities?: ResolvedAgentCapabilities;
  executionEnvironment?: ExecutionEnvironmentHandle;
  requestConfigurationStore?: AgentRequestConfigurationReader;
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
  /** Trusted internal flag; not constructible from user/Agent tool input. */
  internalTextOnly?: boolean;
}): ToolLimit {
  if (options.internalTextOnly) return { kind: "none" };
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

export async function createVykorRuntime(
  options: VykorRuntimeOptions,
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
    internalTextOnly: configuration.internalTextOnly,
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
    disabled: configuration.internalTextOnly === true,
    cwd: options.executionEnvironment?.workspace.executionRoot ?? hostCwd,
    sessionId: options.sessionId,
    settings,
    processExecutor: options.executionEnvironment?.process,
  });
  const runtimeModel = resolveRuntimeModel(settings, configuration);

  // 自定义 prompt 优先。默认提示仅列普通 Skill；有 Run View 时按该次范围重建摘要。
  const buildSystemPrompt = (
    skillsList: Array<{ name: string; description: string }> | undefined,
    effort = configuration.effort ?? settings.effort,
    promptSettings: {
      systemPrompt?: string;
      workStyle?: Settings["workStyle"];
      fastMode?: boolean;
    } = {
      systemPrompt: settings.systemPrompt,
      workStyle: settings.workStyle,
      fastMode: configuration.fastMode ?? settings.fastMode,
    },
    tools: readonly ToolDefinition[] = toolRegistry.getAll(),
  ) => {
    const names = new Set(tools.map((tool) => tool.name));
    return buildRuntimeSystemPrompt({
      customPrompt: promptSettings.systemPrompt,
      cwd: hostCwd,
      environmentInfo: options.executionEnvironment?.info,
      permissionMode: mode,
      workStyle: promptSettings.workStyle,
      fastMode: promptSettings.fastMode,
      effort,
      passes: settings.passes,
      includeBackgroundShell: ["BackgroundShellCreate", "JobWait", "JobRead"].every((name) => names.has(name)),
      includeDelegation: ["Agent", "JobWait", "JobRead", "JobSend", "JobCancel"].every((name) => names.has(name)),
      skillsList: names.has("Skill") ? skillsList : undefined,
    });
  };
  const createPromptBuilder = (
    view: RunCapabilityView | undefined,
    customPrompt: string | undefined,
    effort = configuration.effort ?? settings.effort,
    promptSettings?: Parameters<typeof buildSystemPrompt>[2],
  ) => async (tools: readonly ToolDefinition[]) => {
    const prompt = customPrompt ?? await buildSystemPrompt(
      (view ? [...view.skills.values()].map((binding) => binding.definition)
        : options.skillRegistry?.getNonPluginSkills())?.filter((skill) => !skill.disableModelInvocation),
      effort, promptSettings, tools,
    );
    if (!tools.some((tool) => tool.name === "Agent") || !view?.agents.size) return prompt;
    const agents = [...view.agents].map(([name, { definition }]) => JSON.stringify({ name, description: definition.description }));
    return `${prompt}\n\n# Available agents\nUse Agent with subagentType set to one of these names:\n${agents.join("\n")}`;
  };
  const systemPrompt = configuration.systemPrompt ?? await buildSystemPrompt(
    options.skillRegistry?.getNonPluginSkills().filter((skill) => !skill.disableModelInvocation),
  );
  let resolvedClient: StreamingMessageClient | undefined = apiClient;
  let resolvedClientKey: string | undefined = configuration.client
    ? undefined
    : JSON.stringify([
      configuration.provider ?? settings.provider,
      configuration.baseUrl ?? settings.baseUrl,
      configuration.apiFormat ?? settings.apiFormat,
      runtimeModel,
    ]);
  const resolveRequestConfiguration = options.requestConfigurationStore
    ? async (input: { capabilityView?: RunCapabilityView }) => {
      const snapshot = await options.requestConfigurationStore!.read();
      const requestConfiguration = {
        ...configuration,
        ...snapshot.configuration,
        baseUrl: snapshot.configuration.baseUrl,
      };
      const effort = snapshot.configuration.effort;
      const sessionPrompt = Object.prototype.hasOwnProperty.call(
        snapshot.configuration, "systemPrompt",
      ) ? snapshot.configuration.systemPrompt : configuration.systemPrompt;
      const settingsPrompt = Object.prototype.hasOwnProperty.call(
        snapshot.configuration, "settingsPrompt",
      ) ? snapshot.configuration.settingsPrompt : settings.systemPrompt;
      const systemPromptForTools = createPromptBuilder(
        input.capabilityView,
        sessionPrompt?.trim() ? sessionPrompt : undefined,
        effort,
        {
          systemPrompt: settingsPrompt,
          workStyle: snapshot.configuration.workStyle ?? settings.workStyle,
          fastMode: snapshot.configuration.fastMode ?? configuration.fastMode ?? settings.fastMode,
        },
      );
      const clientKey = JSON.stringify([
        requestConfiguration.provider,
        requestConfiguration.baseUrl,
        requestConfiguration.apiFormat,
        requestConfiguration.model,
      ]);
      if (!configuration.client && clientKey !== resolvedClientKey) {
        resolvedClient = await resolveApiClient(
          settings,
          requestConfiguration,
          storage,
          options.sessionId,
        );
        resolvedClientKey = clientKey;
      }
      const declaredEfforts = await configuration.resolveReasoningEfforts?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
      });
      const reasoningEffort = effort && (
        configuration.client || declaredEfforts?.includes(effort)
      ) ? effort : undefined;
      const contextWindow = await configuration.resolveModelContextWindow?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
      });
      const outputLimit = await configuration.resolveModelOutputLimit?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
      });
      const outputCap = settings.outputTokenMax ?? DEFAULT_OUTPUT_TOKEN_MAX;
      const maxOutputTokens = resolveOutputTokenCap(outputLimit, outputCap);
      return {
        revision: snapshot.revision,
        ...snapshot.configuration,
        client: resolvedClient!,
        systemPromptForTools,
        maxOutputTokens,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      };
    }
    : undefined;

  const engineOptions = {
    trustedToolOverrides: new Map([...trustedOverrides].map((name) => [name, baseToolRegistry.get(name)!])),
    maxTurns: configuration.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: runtimeModel,
    reasoningEffort: configuration.reasoningEffort,
    cwd,
    sessionId: options.sessionId,
    shellOutputLogs: createShellOutputLogHost(),
    settings,
    executionEnvironment: options.executionEnvironment,
    skillRegistry: options.skillRegistry,
    ...(resolveRequestConfiguration ? { resolveRequestConfiguration } : {}),
    systemPromptForTools: (tools: readonly ToolDefinition[], view?: RunCapabilityView) => createPromptBuilder(view, configuration.systemPrompt)(tools),
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
  configuration: VykorAgentConfiguration,
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

export function intersectToolLimits(left: ToolLimit, right: ToolLimit): ToolLimit {
  if (left.kind === "none" || right.kind === "none") return { kind: "none" };
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
