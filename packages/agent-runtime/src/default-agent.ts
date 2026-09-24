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

interface InternalAgentOptions {
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
}

interface DefaultNodeAgentInternals {
  createLocalTerminal: typeof createDefaultNodeTerminal;
}

/** 默认 Node 组装：会读取本机配置、发现扩展，并安装 Node 能力。 */
export async function createDefaultNodeAgent(
  options: VykorAgentOptions = {},
): Promise<VykorAgent> {
  return await createDefaultNodeAgentWithInternals(options, {
    createLocalTerminal: createDefaultNodeTerminal,
  });
}

/** @internal Test seam for verifying host-provided Terminal precedence. */
export async function createDefaultNodeAgentWithInternals(
  options: VykorAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<VykorAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  return await createDefaultNodeAgentInternal(
    options,
    {
      eventBus,
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
          childDirectory: internal.childDirectory,
          identity,
        },
        internals,
      ),
  });
  return createAssembledAgent({
    ...composition,
    eventBus: internal.eventBus,
    effects,
    identity: internal.identity,
    childDirectory: internal.childDirectory,
  });
}
