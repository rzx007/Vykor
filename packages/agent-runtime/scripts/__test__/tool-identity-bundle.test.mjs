import { test } from "node:test";
import assert from "node:assert/strict";

// Import the actual shipping artifact: Vitest's source aliases cannot prove this boundary.
const runtime = await import("../../dist/index.js");
const readNames = ["Read", "Glob", "Grep", "ToolResult"];

function assertHostIdentityExports() {
  for (const name of ["markTrustedReadOnlyTool", "isTrustedReadOnlyTool", "isToolResultReader"])
    assert.equal(typeof runtime[name], "function", `Runtime bundle must expose its own ${name}`);
}

test("shipping Runtime helpers recognize captured builtin read identities", () => {
  assertHostIdentityExports();
  const registry = runtime.createDefaultToolRegistry();
  const view = runtime.createRunCapabilityView({ toolRegistry: registry });
  for (const name of readNames) {
    const binding = view.tools.get(name);
    assert.equal(binding.source.kind, "builtin");
    assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity), true, name);
    assert.equal(runtime.isToolResultReader(binding.definition, binding.definitionIdentity), name === "ToolResult", name);
  }
});

test("a host wrapper registered by Runtime retains identity when Runtime captures it", () => {
  assertHostIdentityExports();
  let hostWrapper;
  const registry = runtime.createDefaultToolRegistry({ toolDecorators: [{ name: "Read", decorate(base) {
    assert.equal(runtime.isTrustedReadOnlyTool(base), true);
    hostWrapper = runtime.markTrustedReadOnlyTool({ ...base, execute: async (...args) => base.execute(...args) });
    return hostWrapper;
  } }] });
  const binding = runtime.createRunCapabilityView({ toolRegistry: registry }).tools.get("Read");
  assert.notEqual(binding.definition, hostWrapper, "The host must verify the frozen Run copy, not only the original object");
  assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity), true);
  assert.equal(runtime.isToolResultReader(binding.definition, binding.definitionIdentity), false);
});

test("shipping Runtime captures job readers without trusting job controls", () => {
  const jobs = { list: async () => ({ jobs: [], errors: [] }) };
  const registry = runtime.createDefaultToolRegistry({ jobs });
  const view = runtime.createRunCapabilityView({ toolRegistry: registry });
  for (const [name, expected] of [["JobList", true], ["JobRead", true], ["JobWait", true], ["JobSend", false], ["JobCancel", false]]) {
    const binding = view.tools.get(name);
    assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity), expected, name);
  }
});

test("shipping Runtime preserves a host input restriction across frozen Run copies", () => {
  const registry = runtime.createDefaultToolRegistry();
  registry.register(runtime.markTrustedReadOnlyTool({ name: "Browser", description: "mixed host tool", inputSchema: {},
    execute: async () => ({ content: [] }),
  }, input => input.action === "inspect"), { kind: "builtin" });
  const binding = runtime.createRunCapabilityView({ toolRegistry: registry }).tools.get("Browser");
  assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity), false);
  assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity, { action: "inspect" }), true);
  assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity, { action: "navigate" }), false);
  assert.equal(runtime.isTrustedReadOnlyTool({ ...binding.definition, execute: async () => ({ content: [] }) }, binding.definitionIdentity, { action: "inspect" }), false);
});

test("shipping helpers reject same-name execute replacements and read-only hints", () => {
  assertHostIdentityExports();
  for (const name of readNames) {
    const registry = runtime.createDefaultToolRegistry({ toolDecorators: [{ name, decorate: base => ({
      ...base, safeToRetry: true, annotations: { readOnlyHint: true },
      execute: async () => ({ content: [{ type: "text", text: "replacement" }] }),
    }) }] });
    const binding = runtime.createRunCapabilityView({ toolRegistry: registry }).tools.get(name);
    assert.equal(binding.source.kind, "builtin");
    assert.equal(runtime.isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity), false, name);
    assert.equal(runtime.isToolResultReader(binding.definition, binding.definitionIdentity), false, name);
  }
  const original = runtime.createRunCapabilityView({ toolRegistry: runtime.createDefaultToolRegistry() }).tools.get("ToolResult");
  const changed = { ...original.definition, execute: async () => ({ content: [] }) };
  assert.equal(runtime.isTrustedReadOnlyTool(changed, original.definitionIdentity), false);
  assert.equal(runtime.isToolResultReader(changed, original.definitionIdentity), false);
});
