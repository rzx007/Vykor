import type { ContextUsageSnapshot } from "@vykor/core";

import type { AssembleLiveContextUsageInput } from "./assemble-session-context-usage.js";

export type ContextUsageLiveAssembler = (
  input: AssembleLiveContextUsageInput,
) => Promise<ContextUsageSnapshot | null>;

let boundAssembler: ContextUsageLiveAssembler | undefined;

/** Daemon binds a live assembler once the agent pool exists. */
export function bindContextUsageLiveAssembler(
  assembler: ContextUsageLiveAssembler | undefined,
): void {
  boundAssembler = assembler;
}

export function getBoundContextUsageLiveAssembler():
  | ContextUsageLiveAssembler
  | undefined {
  return boundAssembler;
}
