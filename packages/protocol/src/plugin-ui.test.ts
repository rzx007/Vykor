import { describe, expect, it } from "vitest";
import { readPluginUiAction, readPluginUiInstance, readPluginUiProposal, stringifyPluginUiJson } from "./index.js";

const instanceId = "10000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const instance = {
  schemaVersion: 2, instanceId, sessionId: "session", sourceRunId: "run", sourcePartId: "part",
  sourceToolUseId: "tool-use", sourceToolName: "inspect", pluginId: "example", pluginVersion: "1",
  pluginDigest: "a".repeat(64), componentDigest: "b".repeat(64), componentId: "card", title: "结果",
  surface: "session-sidebar", status: "open", revision: 0, data: {}, createdAt: 1, updatedAt: 1,
};

it("rejects old instance records, missing positions and unknown positions", () => {
  expect(readPluginUiInstance({ pluginUi: instance })).toEqual(instance);
  for (const change of [
    { schemaVersion: 1 }, { surface: undefined }, { surface: "global" },
    { surface: ["session-sidebar"] }, { surfaces: ["session-sidebar"] },
  ]) expect(readPluginUiInstance({ pluginUi: { ...instance, ...change } })).toBeUndefined();
});

it("requires current action association with strict execution fields", () => {
  const action = {
    schemaVersion: 2, instanceId, requestId, requestFingerprint: "c".repeat(64), expectedRevision: 0,
    actionId: "apply", label: "应用", args: {}, pluginId: "example", pluginVersion: "1",
    pluginDigest: "a".repeat(64), componentDigest: "b".repeat(64), toolName: "apply",
    toolUseId: "use", executionState: "not_started",
  };
  expect(readPluginUiAction({ uiAction: action })).toEqual(action);
  for (const change of [{ schemaVersion: 1 }, { instanceId: "forged" }, { executionState: "running" }, { extra: true }])
    expect(readPluginUiAction({ uiAction: { ...action, ...change } })).toBeUndefined();
});

it("accepts only current proposals and rejects injected positions", () => {
  const proposal = { schemaVersion: 2, componentId: "card", data: {} };
  expect(readPluginUiProposal({ ui: proposal })).toEqual(proposal);
  expect(readPluginUiProposal({ ui: { ...proposal, schemaVersion: 1 } })).toBeUndefined();
  expect(readPluginUiProposal({ ui: { ...proposal, surface: "tool-result" } })).toBeUndefined();
});

describe("stringifyPluginUiJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(stringifyPluginUiJson({ z: [{ b: 2, a: 1 }, false], a: null }))
      .toBe('{"a":null,"z":[{"a":1,"b":2},false]}');
    expect(stringifyPluginUiJson(JSON.parse('{"2":2,"10":10}')))
      .toBe('{"10":10,"2":2}');
  });

  it("preserves empty containers and literal special property names", () => {
    expect(stringifyPluginUiJson({ list: [], record: {} })).toBe('{"list":[],"record":{}}');
    expect(stringifyPluginUiJson(JSON.parse('{"__proto__":{"safe":true},"constructor":1}')))
      .toBe('{"__proto__":{"safe":true},"constructor":1}');
  });

  it.each([NaN, Infinity, -Infinity, undefined, 1n, new Date(), () => 1, Symbol("ui")])
    ("rejects non-JSON values: %s", value => {
      expect(() => stringifyPluginUiJson(value)).toThrow();
    });

  it("rejects nested undefined and sparse arrays instead of dropping values", () => {
    expect(() => stringifyPluginUiJson({ value: undefined })).toThrow();
    expect(() => stringifyPluginUiJson(new Array(2))).toThrow();
  });

  it("accepts twenty containers and rejects deeper or cyclic data", () => {
    let value: unknown = null;
    for (let i = 0; i < 20; i++) value = { nested: value };
    expect(() => stringifyPluginUiJson(value)).not.toThrow();
    expect(() => stringifyPluginUiJson({ nested: value })).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => stringifyPluginUiJson(cycle)).toThrow();
  });
});
