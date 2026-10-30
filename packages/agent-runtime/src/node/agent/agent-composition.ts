import {
  NodeChildManager,
  type NodeChildManagerOptions,
} from "../children/node-child-manager.js";
import type { AgentChildManager } from "../../kernel/children/child-agent.js";
import type { NodeRuntimeResources as RuntimeBundle } from "../runtime/node-runtime-resources.js";
import type { AgentRequestConfigurationReader } from "@vykor/host-config";
import { DEFAULT_REPLY_STYLE } from "@vykor/agent-contracts/reply-style";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import type { TerminalProvider } from "@vykor/terminal";
import type { TeamRegistry } from "@vykor/coordinator/teams";
import type { WorkflowHostDirectory } from "../workflow/workflow-host-directory.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { AgentSession } from "@vykor/core";
import type { McpRuntimeRegistry } from "@vykor/mcp";
import type { McpServerConfig, Settings } from "@vykor/host-config";
import { createAgentSession } from "@vykor/core";
import { getSkillsDir, loadSettings } from "@vykor/host-config";
import type { McpClientManager } from "@vykor/mcp";

import { createWorkspaceBinding } from "@vykor/environment";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import {
  createExecutionEnvironment,
  hostPathToWslPath,
  resolveExecutionEnvironmentConfig,
  settingsForApprovalMode,
} from "@vykor/sandbox";
import { normalizeApprovalMode } from "@vykor/host-config";
import { createEnvironmentFileSystem } from "@vykor/tools";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  VykorAgentConfiguration,
} from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "../capabilities/capability-resolution.js";
import type { AgentChildRegistry } from "../../kernel/children/child-agent.js";
import {
  CleanupStack,
  cleanupAfterInitializationFailure,
} from "../runtime/cleanup-stack.js";
import type { DefaultNodeTerminalResolution } from "../environment/default-node-terminal.js";
import { resolveDefaultAgentCapabilities } from "../capabilities/default-agent-capabilities.js";
import { createVykorRuntime } from "../runtime/default-runtime.js";
import type { AgentEventBus } from "../../kernel/event-source.js";
import {
  discoverVykorExtensions,
  type VykorAgentExtension,
} from "../plugins/extensions.js";
import type { AgentMemoryRuntime } from "../memory/memory-runtime.js";
import { installRuntimeIntegrations } from "../runtime/runtime-integrations.js";
import { createMemoryRequestConfigurationStore } from "../configuration/request-configuration.js";
import type { PluginSelectionCatalog } from "../plugins/plugin-selection.js";
import type { PluginAppBackendCatalogue } from "../plugin-apps/plugin-app-backends.js";

interface AgentCompositionOptions extends VykorAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  extensions?: VykorAgentExtension[];
  childIdleTtlMs?: number;
  mcpRuntimeRegistry?: McpRuntimeRegistry;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
}

export interface AgentIdentity {
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentCompositionContext {
  runCatalogue: import("../capabilities/node-run-catalogue.js").NodeRunCatalogue;
  teams: TeamRegistry;
  workflowHosts: WorkflowHostDirectory;
  ownsWorkflowHosts?: boolean;
  executionOwner: ExecutionRuntimeOwner;
  ownsExecutionOwner?: boolean;
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
  createAgent: NodeChildManagerOptions["createAgent"];
  resolveDefaultTerminal(input: {
    override: TerminalProvider | false | undefined;
    cwd: string;
    sessionId: string;
  }): Promise<DefaultNodeTerminalResolution>;
}

export interface AgentComposition {
  workflowHost?: import("../workflow/workflow-host.js").WorkflowHost;
  stopBackgroundWork: () => Promise<void>;
  runtime: RuntimeBundle;
  pluginApps: PluginAppBackendCatalogue;
  pluginSelection: PluginSelectionCatalog;
  session: AgentSession;
  mcpConnections: () => ReturnType<McpClientManager["getConnections"]>;
  retainMcpConnectionsForRun: () => () => void;
  memory: AgentMemoryRuntime | undefined;
  childManager: AgentChildManager;
  capabilities: ResolvedAgentCapabilities;
  jobs: import("@vykor/jobs").AgentJobHost;
  model: string;
  requestConfigurationStore: AgentRequestConfigurationReader;
  cleanup: CleanupStack;
}

export async function composeVykorAgent(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
): Promise<AgentComposition> {
  const cleanup = new CleanupStack();
  if (internal.ownsExecutionOwner)
    cleanup.add(() => internal.executionOwner.close(), internal.executionOwner);
  if (internal.ownsWorkflowHosts)
    cleanup.add(() => internal.workflowHosts.close(), internal.workflowHosts);
  const rollback = new CleanupStack();
  rollback.add(() => cleanup.close(), cleanup);
  try {
    return await composeVykorAgentInternal(
      options,
      internal,
      cleanup,
      rollback,
    );
  } catch (error) {
    return await cleanupAfterInitializationFailure(rollback, error);
  }
}

async function composeVykorAgentInternal(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
  cleanup: CleanupStack,
  rollback: CleanupStack,
): Promise<AgentComposition> {
  const cwd = options.cwd ?? process.cwd();
  const settings = settingsForApprovalMode(
    options.settings ?? (await loadSettings({})),
    options.approvalMode ??
      normalizeApprovalMode(
        options.permissionMode ?? options.settings?.permission.mode,
      ),
  );
  const sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
  let activeRuntime: RuntimeBundle | undefined;
  let ownsExecutionEnvironment = options.ownsExecutionEnvironment === true;
  let executionEnvironment: ExecutionEnvironmentHandle | undefined =
    await options.executionEnvironment?.({ sessionId, cwd, settings });
  if (options.executionEnvironment && !executionEnvironment) {
    throw new Error(`Execution environment factory returned no lease: ${sessionId}`);
  }
  if (!options.executionEnvironment && options.executionSurface === "desktop_managed") {
    const config = resolveExecutionEnvironmentConfig({
      surface: "desktop_managed",
      settings,
      cwd,
    });
    const baseEnvironment = await createExecutionEnvironment({
      config,
      settings,
      binding: createAgentWorkspaceBinding(cwd, config.kind),
      sessionId,
      userSkillsRoot: getSkillsDir(),
    });
    executionEnvironment = {
      ...baseEnvironment,
      files: createEnvironmentFileSystem(baseEnvironment),
    };
    ownsExecutionEnvironment = true;
  }
  if (executionEnvironment && ownsExecutionEnvironment) {
    const supplied = executionEnvironment;
    let released: Promise<void> | undefined;
    executionEnvironment = {
      ...supplied,
      release: () =>
        (released ??= Promise.resolve().then(() => supplied.release())),
    };
    rollback.add(
      () =>
        ownsExecutionEnvironment ? executionEnvironment?.release() : undefined,
      executionEnvironment,
    );
  }
  if (
    executionEnvironment &&
    resolve(executionEnvironment.workspace.hostRoot) !== resolve(cwd)
  ) {
    throw new Error(
      `Execution environment workspace does not match session cwd: ${sessionId}`,
    );
  }
  const discovery = await discoverVykorExtensions(cwd, settings, {
    pluginsEnabled: options.internalTextOnly ? false : options.pluginsEnabled,
  });
  for (const warning of discovery.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }
  const environment = await resolveDefaultAgentCapabilities({
    runCatalogue: internal.runCatalogue,
    workflowHosts: internal.workflowHosts,
    agentDefinitions: discovery.agentDefinitions,
    settings,
    executionOwner: internal.executionOwner,
    configuration: options,
    configurationForChild: () => {
      const applied =
        activeRuntime?.queryEngine.getAppliedRequestConfiguration?.();
      return {
        ...options,
        workMode:
          activeRuntime?.permissionChecker.getMode?.() === "plan"
            ? "plan"
            : options.workMode,
        permissionMode:
          activeRuntime?.permissionChecker.getMode?.() ??
          options.permissionMode ??
          settings.permission.mode,
        ...(applied
          ? {
              model: applied.model,
              provider: applied.provider,
              baseUrl: applied.baseUrl,
              effort: applied.effort,
              reasoningEffort: applied.reasoningEffort,
              replyStyle: applied.replyStyle,
            }
          : {}),
      };
    },
    capabilityOverrides: options.capabilityOverrides,
    effects: options.effects,
    cwd,
    sessionId,
    childIdleTtlMs: options.childIdleTtlMs,
    eventBus: internal.eventBus,
    childDirectory: internal.childDirectory,
    createAgent: internal.createAgent,
    resolveDefaultTerminal: internal.resolveDefaultTerminal,
    cleanup,
  });
  const requestConfigurationStore =
    options.requestConfigurationStore ??
    createMemoryRequestConfigurationStore(
      {
        model: options.model ?? settings.model,
        replyStyle: options.replyStyle ?? settings.replyStyle ?? DEFAULT_REPLY_STYLE,
        ...((options.provider ?? settings.provider)
          ? { provider: options.provider ?? settings.provider }
          : {}),
        ...((options.baseUrl ?? settings.baseUrl)
          ? { baseUrl: options.baseUrl ?? settings.baseUrl }
          : {}),
        ...((options.apiFormat ?? settings.apiFormat)
          ? { apiFormat: options.apiFormat ?? settings.apiFormat }
          : {}),
        ...((options.effort ?? settings.effort)
          ? { effort: options.effort ?? settings.effort }
          : {}),
      },
      async (next) => next,
    );

  const runtime = await createVykorRuntime({
    runCatalogue: internal.runCatalogue,
    teams: internal.teams,
    workflowTool: environment.workflowTool,
    executionOwner: internal.executionOwner,
    settings,
    cwd,
    sessionId,
    configuration: options,
    capabilities: environment.capabilities,
    executionEnvironment,
    ownsExecutionEnvironment,
    skillRegistry: discovery.skillRegistry,
    agentDefinitions: discovery.agentDefinitions,
    requestConfigurationStore,
  });
  ownsExecutionEnvironment = false;
  activeRuntime = runtime;
  rollback.add(() => runtime.close(), runtime);

  const mcpIntegration = await installRuntimeIntegrations({
    cwd,
    sessionId,
    settings,
    runtime,
    discovery,
    extensions: options.internalTextOnly ? [] : options.extensions,
    mcpServers: options.internalTextOnly ? {} : options.mcpServers,
    memory: environment.memory,
    executionEnvironment,
    mcpRuntimeRegistry: options.internalTextOnly
      ? undefined
      : options.mcpRuntimeRegistry,
  });
  const session = createAgentSession({
    queryEngine: runtime.queryEngine,
    sessionId,
  });

  return {
    workflowHost: environment.workflowHost,
    stopBackgroundWork: () =>
      environment.workflowTool?.close() ?? Promise.resolve(),
    runtime,
    pluginSelection: mcpIntegration.pluginSelection,
    pluginApps: mcpIntegration.pluginApps,
    session,
    mcpConnections: mcpIntegration.getConnections,
    retainMcpConnectionsForRun: mcpIntegration.retainConnectionsForRun,
    memory: environment.memory,
    childManager: environment.childManager,
    jobs: environment.jobs,
    capabilities: environment.capabilities,
    model: options.model ?? settings.model,
    requestConfigurationStore,
    cleanup,
  };
}

export function createAgentWorkspaceBinding(
  cwd: string,
  kind: "local" | "wsl",
) {
  return createWorkspaceBinding({
    kind,
    hostRoot: cwd,
    executionRoot: kind === "wsl" ? hostPathToWslPath(cwd) : cwd,
  });
}
