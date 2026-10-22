import { WorkflowHostDirectory } from "./node/workflow/workflow-host-directory.js";
import type { WorkflowHost } from "./node/workflow/workflow-host.js";
import { createTeamRegistry, type TeamRegistry } from "@vykor/coordinator/teams";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { cleanupAfterInitializationFailure } from "./cleanup-stack.js";
import type { AgentEffects } from "@vykor/core";

import {
  createAssembledAgent,
  type VykorAgent,
  type VykorAgentOptions,
} from "./agent.js";
import {
  composeVykorAgent,
  type AgentIdentity,
} from "./agent-composition.js";
import { AgentChildRegistry } from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";
import {
  createDefaultNodeTerminal,
  resolveDefaultNodeTerminal,
} from "./default-node-terminal.js";

export interface DefaultNodeAgentOptions extends VykorAgentOptions {
  /** Borrowed from the embedding host; standalone agents create and close their own owner. */
  executionOwner?: ExecutionRuntimeOwner;
  workflowHost?: WorkflowHost;
}

interface InternalAgentOptions {
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
): Promise<VykorAgent> {
  return await createDefaultNodeAgentWithInternals(options, {
    createLocalTerminal: createDefaultNodeTerminal,
  });
}

/** @internal Test seam for verifying host-provided Terminal precedence. */
export async function createDefaultNodeAgentWithInternals(
  options: DefaultNodeAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<VykorAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  return await createDefaultNodeAgentInternal(
    options,
    {
      eventBus,
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
): Promise<VykorAgent> {
  const effects: AgentEffects = {
    requestPermission: options.effects?.requestPermission ?? (async () => ({
      status: "denied",
      reason: "No permission effect configured",
    })),
    ...(options.effects?.askUserPrompt ? { askUserPrompt: options.effects.askUserPrompt } : {}),
  };
  const composition = await composeVykorAgent(options, {
    ...internal,
    resolveDefaultTerminal: ({ override, cwd, sessionId }) =>
      resolveDefaultNodeTerminal({
        override,
        createLocal: () => internals.createLocalTerminal({ cwd, sessionId }),
      }),
    createAgent: (childOptions, identity) =>
      createDefaultNodeAgentInternal(
        childOptions,
        {
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
    });
  } catch (error) {
    return cleanupAfterInitializationFailure(composition.cleanup, error);
  }
}
