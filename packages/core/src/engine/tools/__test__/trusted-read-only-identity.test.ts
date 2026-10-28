import { describe, expect, it } from "vitest";
import { markTrustedReadOnlyTool, isTrustedReadOnlyTool } from "../trusted-read-only-identity.js";
import { toolDefinitionIdentity } from "../tool-definition-identity.js";

describe("trusted read-only input classification", () => {
  it("requires the captured implementation and a matching actual input for mixed-action tools", () => {
    const definition = markTrustedReadOnlyTool({ name: "Browser", description: "mixed actions", inputSchema: {},
      execute: async () => ({ content: [] }),
    }, input => input.action === "inspect");
    const identity = toolDefinitionIdentity(definition);
    const captured = Object.freeze({ ...definition });
    expect(isTrustedReadOnlyTool(definition)).toBe(false);
    expect(isTrustedReadOnlyTool(captured, identity)).toBe(false);
    expect(isTrustedReadOnlyTool(captured, identity, { action: "inspect" })).toBe(true);
    expect(isTrustedReadOnlyTool(captured, identity, { action: "navigate" })).toBe(false);
    expect(isTrustedReadOnlyTool(captured, Symbol("replacement"), { action: "inspect" })).toBe(false);
    expect(isTrustedReadOnlyTool({ ...captured, execute: async () => ({ content: [] }) }, identity, { action: "inspect" })).toBe(false);
    definition.execute = async () => ({ content: [] });
    expect(isTrustedReadOnlyTool(definition, identity, { action: "inspect" })).toBe(false);
  });
});
