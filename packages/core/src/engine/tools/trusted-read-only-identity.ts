import type { ToolDefinition } from "@vykor/agent-contracts";
import { toolDefinitionIdentity } from "./tool-definition-identity.js";

const definitions = new WeakMap<ToolDefinition, ToolDefinition["execute"]>();
const captured = new WeakMap<ToolDefinition["execute"], Set<symbol>>();

/** Trusted host wiring registers the exact builtin definition and original implementation. */
export function markTrustedReadOnlyTool<T extends ToolDefinition>(definition: T): T {
  definitions.set(definition, definition.execute);
  const identities = captured.get(definition.execute) ?? new Set<symbol>();
  identities.add(toolDefinitionIdentity(definition));
  captured.set(definition.execute, identities);
  return definition;
}

/** A frozen Run copy must carry both the registered identity and original execute function. */
export function isTrustedReadOnlyTool(definition: ToolDefinition, identity?: symbol): boolean {
  return definitions.get(definition) === definition.execute
    || (identity !== undefined && captured.get(definition.execute)?.has(identity) === true);
}
