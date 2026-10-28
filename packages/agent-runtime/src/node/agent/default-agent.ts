import { NodeRunCatalogue } from "../capabilities/node-run-catalogue.js";
import type { AgentEffects } from "@vykor/agent-contracts";
import { WorkflowHostDirectory } from "../workflow/workflow-host-directory.js";
import type { WorkflowHost } from "../workflow/workflow-host.js";
import {
  createTeamRegistry,
  type TeamRegistry,
} from "@vykor/coordinator/teams";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { cleanupAfterInitializationFailure } from "../runtime/cleanup-stack.js";

import {
  createAssembledAgent,
  type DefaultNodeAgent,
  type VykorAgentOptions,
} from "./agent.js";
import { composeVykorAgent, type AgentIdentity } from "./agent-composition.js";
import { AgentChildRegistry } from "../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../kernel/event-source.js";
import {
  createDefaultNodeTerminal,
  resolveDefaultNodeTerminal,
} from "../environment/default-node-terminal.js";

export interface DefaultNodeAgentOptions extends VykorAgentOptions {
  /** Borrowed from the embedding host; standalone agents create and close their own owner. */
  executionOwner?: ExecutionRuntimeOwner;
  workflowHost?: WorkflowHost;
}

interface InternalAgentOptions {
  runCatalogue: NodeRunCatalogue;
  workflowHosts: WorkflowHostDirectory;
  ownsWorkflowHosts?: boolean;
  teams: TeamRegistry;
  executionOwner: ExecutionRuntimeOwner;
  ownsExecutionOwner?: boolean;
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
}

interface DefaultNodeAgentInternals {
  createLocalTerminal: typeof createDefaultNodeTerminal;
}

/** 默认 Node 组装：会读取本机配置、发现扩展，并安装 Node 能力。 */
export async function createDefaultNodeAgent(
  options: DefaultNodeAgentOptions = {},
): Promise<DefaultNodeAgent> {
  return await createDefaultNodeAgentWithInternals(options, {
    createLocalTerminal: createDefaultNodeTerminal,
  });
}

/** @internal Test seam for verifying host-provided Terminal precedence. */
export async function createDefaultNodeAgentWithInternals(
  options: DefaultNodeAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<DefaultNodeAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  return await createDefaultNodeAgentInternal(
    options,
    {
      eventBus,
      runCatalogue: new NodeRunCatalogue(),
      workflowHosts: new WorkflowHostDirectory(options.workflowHost),
      ownsWorkflowHosts: true,
      teams: createTeamRegistry(),
      executionOwner: options.executionOwner ?? new ExecutionRuntimeOwner(),
      ownsExecutionOwner: !options.executionOwner,
      childDirectory: new AgentChildRegistry(),
    },
    internals,
  );
}

async function createDefaultNodeAgentInternal(
  options: VykorAgentOptions,
  internal: InternalAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<DefaultNodeAgent> {
  const effects: AgentEffects = {
    requestPermission:
      options.effects?.requestPermission ??
      (async () => ({
        status: "denied",
        reason: "No permission effect configured",
      })),
    ...(options.effects?.askUserPrompt
      ? { askUserPrompt: options.effects.askUserPrompt }
      : {}),
  };
  const composition = await composeVykorAgent(options, {
    ...internal,
    resolveDefaultTerminal: ({ override, cwd, sessionId }) =>
      resolveDefaultNodeTerminal({
        override, cwd, sessionId,
        createLocal: () => internals.createLocalTerminal({ cwd, sessionId }),
      }),
    createAgent: (childOptions, identity) =>
      createDefaultNodeAgentInternal(
        childOptions,
        {
          runCatalogue: internal.runCatalogue,
          eventBus: internal.eventBus,
          workflowHosts: internal.workflowHosts,
          teams: internal.teams,
          executionOwner: internal.executionOwner,
          childDirectory: internal.childDirectory,
          identity,
        },
        internals,
      ),
  });
  try {
    return createAssembledAgent({
      ...composition,
      eventBus: internal.eventBus,
      effects,
      identity: internal.identity,
      childDirectory: internal.childDirectory,
      onRunCapabilities: options.onRunCapabilities,
      modelAttempts: options.modelAttempts,
      bindToolDispatch: options.bindToolDispatch,
      outputContract: options.outputContract,
      toolResults: options.toolResults,
    });
  } catch (error) {
    return cleanupAfterInitializationFailure(composition.cleanup, error);
  }
}
