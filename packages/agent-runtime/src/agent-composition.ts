import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  McpRuntimeRegistry,
  McpServerConfig,
  RuntimeBundle,
  Settings,
} from "@vykor/core";
import { createAgentSession, getSkillsDir, loadSettings } from "@vykor/core";
import type { McpClientManager } from "@vykor/mcp";
import type { AgentRequestConfigurationReader } from "@vykor/core";
import { createWorkspaceBinding } from "@vykor/environment";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import {
  createExecutionEnvironment,
  hostPathToWslPath,
  resolveExecutionEnvironmentConfig,
} from "@vykor/sandbox";
import { createEnvironmentFileSystem } from "@vykor/tools";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  VykorAgentConfiguration,
} from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "./capability-resolution.js";
import type {
  AgentChildManager,
  AgentChildManagerOptions,
  AgentChildRegistry,
} from "./child-agent.js";
import {
  CleanupStack,
  cleanupAfterInitializationFailure,
} from "./cleanup-stack.js";
import type { DefaultNodeTerminalResolution } from "./default-node-terminal.js";
import { resolveDefaultAgentCapabilities } from "./default-agent-capabilities.js";
import { createVykorRuntime } from "./default-runtime.js";
import type { AgentEventBus } from "./event-source.js";
import {
  discoverVykorExtensions,
  type VykorAgentExtension,
} from "./extensions.js";
import type { AgentMemoryRuntime } from "./memory-runtime.js";
import { installRuntimeIntegrations } from "./runtime-integrations.js";
import { createMemoryRequestConfigurationStore } from "./request-configuration.js";

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
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
  createAgent: AgentChildManagerOptions["createAgent"];
  resolveDefaultTerminal(input: {
    override: AgentCapabilityOverrides["terminal"];
    cwd: string;
    sessionId: string;
  }): Promise<DefaultNodeTerminalResolution>;
}

export interface AgentComposition {
  runtime: RuntimeBundle;
  session: AgentSession;
  mcpConnections: () => ReturnType<McpClientManager["getConnections"]>;
  retainMcpConnectionsForRun: () => () => void;
  memory: AgentMemoryRuntime | undefined;
  childManager: AgentChildManager;
  capabilities: ResolvedAgentCapabilities;
  model: string;
  requestConfigurationStore: AgentRequestConfigurationReader;
  cleanup: CleanupStack;
}

export async function composeVykorAgent(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
): Promise<AgentComposition> {
  const cleanup = new CleanupStack();
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
  const settings = options.settings ?? (await loadSettings({}));
  const discovery = await discoverVykorExtensions(cwd, settings, {
    pluginsEnabled: options.pluginsEnabled,
  });
  for (const warning of discovery.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }

  const sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
  let activeRuntime: RuntimeBundle | undefined;
  let executionEnvironment: ExecutionEnvironmentHandle | undefined =
    options.executionEnvironment;
  if (!executionEnvironment && options.executionSurface === "desktop_managed") {
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
      files: createEnvironmentFileSystem(baseEnvironment, {
        settings,
        sessionId,
      }),
    };
    rollback.add(() => executionEnvironment?.release(), executionEnvironment);
  }
  const environment = await resolveDefaultAgentCapabilities({
    settings,
    configuration: options,
    configurationForChild: () => {
      const applied = activeRuntime?.queryEngine.getAppliedRequestConfiguration?.();
      return applied ? {
        ...options,
        model: applied.model,
        provider: applied.provider,
        baseUrl: applied.baseUrl,
        effort: applied.effort,
        reasoningEffort: applied.reasoningEffort,
      } : options;
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
  const requestConfigurationStore = options.requestConfigurationStore
    ?? createMemoryRequestConfigurationStore(
      {
        model: options.model ?? settings.model,
        ...(options.provider ?? settings.provider ? { provider: options.provider ?? settings.provider } : {}),
        ...(options.baseUrl ?? settings.baseUrl ? { baseUrl: options.baseUrl ?? settings.baseUrl } : {}),
        ...(options.apiFormat ?? settings.apiFormat ? { apiFormat: options.apiFormat ?? settings.apiFormat } : {}),
        ...(options.effort ?? settings.effort ? { effort: options.effort ?? settings.effort } : {}),
      },
      async (next) => next,
    );

  const runtime = await createVykorRuntime({
    settings,
    cwd,
    sessionId,
    configuration: options,
    capabilities: environment.capabilities,
    executionEnvironment,
    skillRegistry: discovery.skillRegistry,
    agentDefinitions: discovery.agentDefinitions,
    requestConfigurationStore,
  });
  activeRuntime = runtime;
  rollback.add(() => runtime.close(), runtime);

  const mcpIntegration = await installRuntimeIntegrations({
    cwd,
    sessionId,
    settings,
    runtime,
    discovery,
    extensions: options.extensions,
    mcpServers: options.mcpServers,
    memory: environment.memory,
    executionEnvironment,
    mcpRuntimeRegistry: options.mcpRuntimeRegistry,
  });
  const session = createAgentSession({
    queryEngine: runtime.queryEngine,
    sessionId,
  });

  return {
    runtime,
    session,
    mcpConnections: mcpIntegration.getConnections,
    retainMcpConnectionsForRun: mcpIntegration.retainConnectionsForRun,
    memory: environment.memory,
    childManager: environment.childManager,
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
