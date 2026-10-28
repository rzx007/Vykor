import type {
  AgentEffects,
  AgentRunPreparation,
  AgentEventListener,
  AgentChildBudget,
  StreamingMessageClient,
  ToolDefinition,
} from "@vykor/agent-contracts";
import { readonlyMap } from "@vykor/agent-contracts";
import {
  QueryEngine,
  ToolRegistry,
  type IQueryEngine as Engine,
  type QueryEngineOptions,
} from "@vykor/core/engine";
import { KernelAgent, type VykorAgent } from "./agent.js";
import { AgentEventBus } from "./event-source.js";
import {
  AgentChildManager,
  type AgentChildManagerOptions,
} from "./children/child-agent.js";
import { AgentChildRegistry } from "./children/child-registry.js";
export interface AgentKernelOptions {
  outputContract?: import("@vykor/agent-contracts").AgentOutputContract;
  bindToolDispatch?: import("@vykor/agent-contracts").ToolDispatchCheckFactory;
  id?: string;
  sessionId?: string;
  cwd: string;
  engine: Engine;
  effects: AgentEffects;
  preparation: AgentRunPreparation;
  release?(): void | Promise<void>;
  onEvent?: AgentEventListener;
  childBudget?: AgentChildBudget;
  childIdleTtlMs?: number;
  childEnvironment?: AgentChildManagerOptions["environment"];
  resolveChild?: AgentChildManagerOptions["resolveChild"];
}
export type AgentKernelRuntime = Engine;
export type AgentKernelRuntimeContext = Pick<
  AgentKernelOptions,
  "cwd" | "sessionId"
>;
export async function createAgentKernel(
  options: AgentKernelOptions,
): Promise<VykorAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  const directory = new AgentChildRegistry(options.childBudget);
  const children = new AgentChildManager({
    cwd: options.cwd,
    idleTtlMs: options.childIdleTtlMs,
    eventBus,
    directory,
    environment: options.childEnvironment,
    resolveChild:
      options.resolveChild ??
      (() => {
        throw new Error("Child factory is not configured");
      }),
  });
  return new KernelAgent({
    id:
      options.id ??
      options.sessionId ??
      `agent_session_${globalThis.crypto.randomUUID()}`,
    cwd: options.cwd,
    engine: options.engine,
    effects: options.effects,
    preparation: options.preparation,
    bindToolDispatch: options.bindToolDispatch,
    outputContract: options.outputContract,
    eventBus,
    childManager: children,
    childDirectory: directory,
    release: options.release,
  });
}
export interface BasicAgentKernelRuntimeOptions extends QueryEngineOptions {
  client: StreamingMessageClient;
  tools?: readonly ToolDefinition[];
}
export function createBasicAgentKernelRuntime(
  options: BasicAgentKernelRuntimeOptions,
): Engine {
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  return new QueryEngine(
    options.client,
    registry,
    {
      async checkTool() {
        return { action: "ask", reason: "Kernel host approval is required" };
      },
    },
    {
      async execute() {
        return { blocked: false };
      },
    },
    options,
  );
}
