import type { ContextUsageSnapshot } from "@vykor/core";

import type { AssembleLiveContextUsageInput } from "./assemble-session-context-usage.js";

export type ContextUsageLiveAssembler = (
  input: AssembleLiveContextUsageInput,
) => Promise<ContextUsageSnapshot | null>;

let currentBinding: { assembler: ContextUsageLiveAssembler } | undefined;

/** Each binding owns its release, including repeated bindings of the same callback. */
export function bindContextUsageLiveAssembler(
  assembler: ContextUsageLiveAssembler,
): () => void {
  const binding = { assembler };
  currentBinding = binding;
  return () => {
    if (currentBinding === binding) currentBinding = undefined;
  };
}

export function getBoundContextUsageLiveAssembler():
  | ContextUsageLiveAssembler
  | undefined {
  return currentBinding?.assembler;
}
