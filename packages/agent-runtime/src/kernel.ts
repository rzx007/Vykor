import type {
  AgentEffects,
  StreamingMessageClient,
  ToolDefinition,
  RuntimeBundle,
  Settings,
} from "@vykor/core";
import {
  createAgentSession,
  QueryEngine,
  RuntimeBuilder,
  ToolRegistry,
} from "@vykor/core";

import {
  createAssembledAgent,
  type VykorAgent,
  type VykorAgentOptions,
} from "./agent.js";
import type { VykorAgentConfiguration } from "./agent-options.js";
import type {
  ResolvedAgentCapabilities,
  ResolvedCapability,
} from "./capability-resolution.js";
import {
  AgentChildManager,
  AgentChildRegistry,
} from "./child-agent.js";
import type { AgentChildEnvironmentProvider } from "./child-environment.js";
import type { AgentIdentity } from "./agent-composition.js";
import { AgentEventBus } from "./event-source.js";

export interface AgentKernelRuntimeContext {
  cwd: string;
  sessionId?: string;
  settings: Settings;
  configuration: VykorAgentConfiguration;
  /** 已解析能力原样传给 child，runtime factory 不能凭空扩大权限。 */
  capabilities: ResolvedAgentCapabilities;
  identity?: AgentIdentity;
}

export interface AgentKernelRuntime {
  runtime: RuntimeBundle;
  model?: string;
}

export interface BasicAgentKernelRuntimeOptions {
  settings: Settings;
  cwd: string;
  client: StreamingMessageClient;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  tools?: ToolDefinition[];
}

/**
 * 给独立包和测试宿主用的最小 runtime：只有调用方给出的 client 和 tools。
 * 不加载默认工具、凭据、hooks、Skill、MCP、Sandbox 或本机配置。
 */
export function createBasicAgentKernelRuntime(
  options: BasicAgentKernelRuntimeOptions,
): AgentKernelRuntime {
  const toolRegistry = new ToolRegistry();
  for (const tool of options.tools ?? []) toolRegistry.register(tool);
  const permissionChecker = {
    async checkTool() {
      return {
        action: "ask" as const,
        reason: "Kernel host approval is required",
      };
    },
  };
  const hookExecutor = {
    register() {},
    getAll: () => [],
    async execute() {
      return { blocked: false };
    },
  };
  const queryEngine = new QueryEngine(
    options.client,
    toolRegistry,
    permissionChecker,
    hookExecutor,
    {
      settings: options.settings,
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model ?? options.settings.model,
      systemPrompt: options.systemPrompt ?? "You are a helpful assistant.",
      maxTurns: options.maxTurns ?? options.settings.maxTurns,
    },
  );
  return {
    runtime: new RuntimeBuilder()
      .setApiClient(options.client)
      .setToolRegistry(toolRegistry)
      .setPermissionChecker(permissionChecker)
      .setHookExecutor(hookExecutor)
      .setQueryEngine(queryEngine)
      .build(options.settings),
    model: options.model ?? options.settings.model,
  };
}

export interface AgentKernelOptions {
  /** Kernel 只使用调用方给出的 settings，不读取用户目录。 */
  settings: Settings;
  cwd: string;
  sessionId?: string;
  configuration?: VykorAgentConfiguration;
  capabilities: ResolvedAgentCapabilities;
  effects: AgentEffects;
  createRuntime(
    context: AgentKernelRuntimeContext,
  ): Promise<AgentKernelRuntime>;
  onEvent?: VykorAgentOptions["onEvent"];
  childIdleTtlMs?: number;
}

interface KernelTreeContext {
  eventBus: AgentEventBus;
  effects: AgentEffects;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
}

/**
 * 只负责 Agent/Run/Child 生命周期的运行核心。
 *
 * 它不会加载 settings、凭据、插件、Skill、MCP、Sandbox、Memory 或 Git；
 * 这些对象必须由宿主在 createRuntime/capabilities 中明确交进来。
 */
export async function createAgentKernel(
  options: AgentKernelOptions,
): Promise<VykorAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  return await createAgentKernelInternal(options, {
    eventBus,
    effects: options.effects,
    childDirectory: new AgentChildRegistry(),
  });
}

async function createAgentKernelInternal(
  options: AgentKernelOptions,
  tree: KernelTreeContext,
): Promise<VykorAgent> {
  const configuration = options.configuration ?? {};
  const prepared = await options.createRuntime({
    cwd: options.cwd,
    sessionId: options.sessionId,
    settings: options.settings,
    configuration,
    capabilities: options.capabilities,
    identity: tree.identity,
  });
  const runtime = prepared.runtime;
  try {
    runtime.queryEngine.setTerminal(capabilityValue(options.capabilities.terminal));
    runtime.queryEngine.setJobs(capabilityValue(options.capabilities.jobs));
    runtime.queryEngine.setBackgroundShell(capabilityValue(options.capabilities.backgroundShell));
    runtime.queryEngine.setSchedules(capabilityValue(options.capabilities.schedules));
    const session = createAgentSession({
      queryEngine: runtime.queryEngine,
      sessionId: options.sessionId,
    });
    const childManager = new AgentChildManager({
      settings: options.settings,
      configuration,
      cwd: options.cwd,
      idleTtlMs: options.childIdleTtlMs,
      eventBus: tree.eventBus,
      directory: tree.childDirectory,
      environment:
        capabilityValue(options.capabilities.childEnvironment) ??
        unavailableChildEnvironment(),
      createAgent: async (childOptions, identity) =>
        await createAgentKernelInternal(
          {
            ...options,
            cwd: childOptions.cwd ?? options.cwd,
            sessionId: childOptions.sessionId,
            configuration: childOptions,
          },
          { ...tree, identity },
        ),
    });
    return createAssembledAgent({
      runtime,
      session,
      mcpConnections: () => [],
      memory: capabilityValue(options.capabilities.memory),
      eventBus: tree.eventBus,
      effects: tree.effects,
      identity: tree.identity,
      childManager,
      childDirectory: tree.childDirectory,
      capabilities: options.capabilities,
      model: prepared.model ?? configuration.model ?? options.settings.model,
    });
  } catch (error) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Agent Kernel creation and cleanup failed",
      );
    }
    throw error;
  }
}

function capabilityValue<T>(capability: ResolvedCapability<T>): T | undefined {
  return capability.status === "available" ? capability.value : undefined;
}

function unavailableChildEnvironment(): AgentChildEnvironmentProvider {
  return {
    async acquire() {
      throw new Error("Child environment capability is not available");
    },
  };
}
