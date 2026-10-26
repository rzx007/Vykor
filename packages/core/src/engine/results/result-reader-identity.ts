import type { ToolDefinition } from "@vykor/agent-contracts";
import { toolDefinitionIdentity } from "../tools/tool-definition-identity.js";
const readers = new WeakMap<ToolDefinition, ToolDefinition["execute"]>();
const capturedReaders = new WeakMap<ToolDefinition["execute"], Set<symbol>>();
/** Called by trusted host wiring on the exact builtin definition, never by tool metadata. */
export function markToolResultReader<T extends ToolDefinition>(definition: T): T {
  readers.set(definition, definition.execute);
  const identities = capturedReaders.get(definition.execute) ?? new Set<symbol>();
  identities.add(toolDefinitionIdentity(definition)); capturedReaders.set(definition.execute, identities);
  return definition;
}
export function isToolResultReader(definition: ToolDefinition, identity?: symbol): boolean {
  return readers.get(definition) === definition.execute || (identity !== undefined && capturedReaders.get(definition.execute)?.has(identity) === true);
}
