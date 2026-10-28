import type { ToolDefinition } from "@vykor/agent-contracts";
import { toolDefinitionIdentity } from "./tool-definition-identity.js";

interface TrustedReadOnlyDefinition {
  execute: ToolDefinition["execute"];
  accepts?: (input: Readonly<Record<string, unknown>>) => boolean;
}
const definitions = new WeakMap<ToolDefinition, TrustedReadOnlyDefinition>();
const captured = new WeakMap<ToolDefinition["execute"], Map<symbol, TrustedReadOnlyDefinition>>();

/** Trusted host wiring registers the exact builtin definition and original implementation. */
export function markTrustedReadOnlyTool<T extends ToolDefinition>(
  definition: T,
  accepts?: TrustedReadOnlyDefinition["accepts"],
): T {
  const trust = { execute: definition.execute, accepts };
  definitions.set(definition, trust);
  const identities = captured.get(definition.execute) ?? new Map<symbol, TrustedReadOnlyDefinition>();
  identities.set(toolDefinitionIdentity(definition), trust);
  captured.set(definition.execute, identities);
  return definition;
}

/** A frozen Run copy must carry both the registered identity and original execute function. */
export function isTrustedReadOnlyTool(
  definition: ToolDefinition,
  identity?: symbol,
  input?: Readonly<Record<string, unknown>>,
): boolean {
  const direct = definitions.get(definition);
  const trust = direct?.execute === definition.execute ? direct
    : identity !== undefined ? captured.get(definition.execute)?.get(identity) : undefined;
  // Mixed-action tools grant nothing unless the actual immutable operation input is supplied.
  return !!trust && (!trust.accepts || (input !== undefined && trust.accepts(input)));
}
