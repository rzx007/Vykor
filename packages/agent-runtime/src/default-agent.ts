import type { AgentEffects } from "@openharness/core";

import {
  createAssembledAgent,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
} from "./agent.js";
import {
  composeOpenHarnessAgent,
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
  options: OpenHarnessAgentOptions = {},
): Promise<OpenHarnessAgent> {
  return await createDefaultNodeAgentWithInternals(options, {
    createLocalTerminal: createDefaultNodeTerminal,
  });
}

/** @internal Test seam for verifying host-provided Terminal precedence. */
export async function createDefaultNodeAgentWithInternals(
  options: OpenHarnessAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<OpenHarnessAgent> {
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
  options: OpenHarnessAgentOptions,
  internal: InternalAgentOptions,
  internals: DefaultNodeAgentInternals,
): Promise<OpenHarnessAgent> {
  const effects: AgentEffects = {
    requestPermission: options.effects?.requestPermission ?? (async () => ({
      status: "denied",
      reason: "No permission effect configured",
    })),
    ...(options.effects?.askUserPrompt ? { askUserPrompt: options.effects.askUserPrompt } : {}),
  };
  const composition = await composeOpenHarnessAgent(options, {
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
