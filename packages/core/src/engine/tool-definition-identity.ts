import type { ToolDefinition } from "../types/tools";

const identities = new WeakMap<ToolDefinition, symbol>();

/** Preserve the identity of a host-approved definition across frozen Run copies. */
export function toolDefinitionIdentity(definition: ToolDefinition): symbol {
  let identity = identities.get(definition);
  if (!identity) {
    identity = Symbol(definition.name);
    identities.set(definition, identity);
  }
  return identity;
}
