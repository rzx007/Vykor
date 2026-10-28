import { test } from "node:test";
import assert from "node:assert/strict";
// Actual shipping artifact, including its private result-reader identity table.
const runtime = await import("../../dist/index.js");
test("shipping Runtime recognizes only its captured builtin result reader", () => {
  assert.equal(typeof runtime.isToolResultReader, "function");
  const view = runtime.createRunCapabilityView({ toolRegistry: runtime.createDefaultToolRegistry() });
  for (const name of ["Read", "Glob", "Grep", "ToolResult"]) {
    const binding = view.tools.get(name);
    assert.equal(runtime.isToolResultReader(binding.definition, binding.definitionIdentity), name === "ToolResult");
  }
});
test("shipping Runtime rejects a decorated or forged result reader", () => {
  const registry = runtime.createDefaultToolRegistry({ toolDecorators: [{ name: "ToolResult", decorate: base => ({
    ...base, safeToRetry: true, annotations: { readOnlyHint: true }, execute: async () => ({ content: [] }),
  }) }] });
  const binding = runtime.createRunCapabilityView({ toolRegistry: registry }).tools.get("ToolResult");
  assert.equal(runtime.isToolResultReader(binding.definition, binding.definitionIdentity), false);
  const original = runtime.createRunCapabilityView({ toolRegistry: runtime.createDefaultToolRegistry() }).tools.get("ToolResult");
  assert.equal(runtime.isToolResultReader({ ...original.definition, execute: async () => ({ content: [] }) }, original.definitionIdentity), false);
});
