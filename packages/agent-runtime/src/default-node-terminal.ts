import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";
import { createAgentTerminalBundle } from "@vykor/terminal-node";

import type { ObservableJobProducer } from "./agent-options.js";
import type { Cleanup } from "./cleanup-stack.js";

export type DefaultNodeTerminalProducer = ObservableJobProducer<AgentTerminalHost>;

export interface CreatedCapability<T> {
  value: T;
  cleanup: Cleanup;
  cleanupIdentity: object;
}

export type DefaultNodeTerminalResolution =
  | ({
      status: "available";
      source: "default";
    } & CreatedCapability<DefaultNodeTerminalProducer>)
  | {
      status: "available";
      source: "override";
      value: DefaultNodeTerminalProducer;
    }
  | { status: "disabled" };

export async function createDefaultNodeTerminal(input: {
  cwd: string;
  sessionId: string;
}): Promise<CreatedCapability<DefaultNodeTerminalProducer>> {
  const bundle = createAgentTerminalBundle(input);
  return {
    value: {
      value: bundle.terminal,
      jobs: bundle.jobs satisfies AgentJobHost,
    },
    cleanup: bundle.cleanup,
    cleanupIdentity: bundle.cleanupIdentity,
  };
}

export async function resolveDefaultNodeTerminal(input: {
  override: DefaultNodeTerminalProducer | false | undefined;
  createLocal: () => Promise<CreatedCapability<DefaultNodeTerminalProducer>>;
}): Promise<DefaultNodeTerminalResolution> {
  if (input.override === false) return { status: "disabled" };
  if (input.override !== undefined) {
    return {
      status: "available",
      source: "override",
      value: input.override,
    };
  }
  return {
    status: "available",
    source: "default",
    ...await input.createLocal(),
  };
}
