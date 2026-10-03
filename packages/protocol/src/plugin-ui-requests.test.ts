import { describe, expect, it } from "vitest";
import {
  parseDismissPluginUiInput, parseInvokePluginUiActionInput, ProtocolValidationError,
  readPluginUiAction, readPluginUiInstance,
  readPluginUiProposal,
} from "./index.js";

const requestId = "2a856850-90b6-420e-b7b3-50f6d5f4f41b";
const instanceId = "9e165b40-292c-4b77-9c14-6aeb018cad90";
const validInput = { requestId, expectedRevision: 0, actionId: "apply", args: { selected: ["line-1"] } };
const instance = {
  schemaVersion: 1, instanceId, sessionId: "s1", sourceRunId: "r1", sourcePartId: "p1",
  sourceToolUseId: "call-1", sourceToolName: "Inspect", pluginId: "dev.example.inspect",
  pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentId: "findings",
  componentDigest: "b".repeat(64), title: "Findings", surfaces: ["tool-result", "session-sidebar"],
  status: "open", revision: 0, data: { findings: [{ line: 1 }] }, createdAt: 1, updatedAt: 2,
};
const action = {
  schemaVersion: 1, instanceId, requestId, requestFingerprint: "c".repeat(64), expectedRevision: 0,
  actionId: "apply", label: "Apply", args: { selected: ["line-1"] }, pluginId: "dev.example.inspect",
  pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentDigest: "b".repeat(64),
  toolName: "Apply", toolUseId: "ui-call-1", executionState: "not_started",
};
const proposal = { schemaVersion: 1, componentId: "findings", data: { findings: [{ line: 1 }] } };

describe("Plugin UI proposals", () => {
  it("reads only complete versioned proposals from plugin metadata.ui", () => {
    expect(readPluginUiProposal({ ui: proposal })).toEqual(proposal);
    expect(readPluginUiProposal(proposal)).toBeUndefined();
    for (const invalid of [null, [], {}, { ...proposal, schemaVersion: 2 }, { ...proposal, componentId: "" },
      { ...proposal, data: { value: Infinity } }, { ...proposal, extra: true }]) {
      expect(readPluginUiProposal({ ui: invalid })).toBeUndefined();
    }
  });

  it("rejects excessive UTF-8 proposal data and nesting", () => {
    const data = { text: "中".repeat(87377) + "xx" };
    expect(readPluginUiProposal({ ui: { ...proposal, data } })?.data).toEqual(data);
    expect(readPluginUiProposal({ ui: { ...proposal, data: { text: data.text + "x" } } })).toBeUndefined();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(readPluginUiProposal({ ui: { ...proposal, data: deep } })).toBeUndefined();
  });
});

describe("Plugin UI action requests", () => {
  it("accepts only action and dismissal request fields", () => {
    expect(parseInvokePluginUiActionInput(validInput)).toEqual(validInput);
    expect(parseDismissPluginUiInput({ requestId, expectedRevision: 0 })).toEqual({ requestId, expectedRevision: 0 });
  });

  it.each(["toolName", "pluginId", "runId", "cwd", "permission", "sessionId", "instanceId", ""])
    ("rejects a client-supplied %s", field => {
      expect(() => parseInvokePluginUiActionInput({ ...validInput, [field]: "forged" })).toThrow(ProtocolValidationError);
      expect(() => parseDismissPluginUiInput({ requestId, expectedRevision: 0, [field]: "forged" })).toThrow(ProtocolValidationError);
    });

  it.each(["not-a-uuid", "", null, 42])("rejects invalid request ID %s", value => {
    expect(() => parseInvokePluginUiActionInput({ ...validInput, requestId: value })).toThrow(ProtocolValidationError);
    expect(() => parseDismissPluginUiInput({ requestId: value, expectedRevision: 0 })).toThrow(ProtocolValidationError);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0", undefined])
    ("rejects invalid revision %s", value => {
      expect(() => parseInvokePluginUiActionInput({ ...validInput, expectedRevision: value })).toThrow(ProtocolValidationError);
      expect(() => parseDismissPluginUiInput({ requestId, expectedRevision: value })).toThrow(ProtocolValidationError);
    });

  it.each([[], null, { invalid: Infinity }, { invalid: undefined }, { invalid: 1n }, new Date()])
    ("rejects non-JSON args %s", args => {
      expect(() => parseInvokePluginUiActionInput({ ...validInput, args })).toThrow(ProtocolValidationError);
    });

  it("enforces UTF-8 args bytes without truncating accepted data", () => {
    const args = { text: "中".repeat(21841) + "xx" }; // JSON is exactly 65536 UTF-8 bytes.
    expect(parseInvokePluginUiActionInput({ ...validInput, args }).args).toEqual(args);
    expect(() => parseInvokePluginUiActionInput({ ...validInput, args: { text: args.text + "x" } })).toThrow(ProtocolValidationError);
  });

  it("rejects deep args and unknown dismissal fields", () => {
    let args: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) args = { nested: args };
    expect(() => parseInvokePluginUiActionInput({ ...validInput, args })).toThrow(ProtocolValidationError);
    expect(() => parseDismissPluginUiInput(validInput)).toThrow(ProtocolValidationError);
    expect(() => parseInvokePluginUiActionInput({ ...validInput, actionId: "" })).toThrow(ProtocolValidationError);
  });
});

describe("host Plugin UI metadata readers", () => {
  it("reads complete records only from host namespaces and preserves opaque source IDs", () => {
    expect(readPluginUiInstance({ pluginUi: instance, ui: {} })).toEqual(instance);
    expect(readPluginUiAction({ uiAction: action })).toEqual(action);
    expect(readPluginUiInstance(instance)).toBeUndefined();
    expect(readPluginUiAction(action)).toBeUndefined();
    expect(readPluginUiInstance({ ui: instance })).toBeUndefined();
  });

  it.each(Object.keys(instance))("requires instance field %s", field => {
    const invalid: Record<string, unknown> = { ...instance };
    delete invalid[field];
    expect(readPluginUiInstance({ pluginUi: invalid })).toBeUndefined();
  });

  it.each(Object.keys(action))("requires action field %s", field => {
    const invalid: Record<string, unknown> = { ...action };
    delete invalid[field];
    expect(readPluginUiAction({ uiAction: invalid })).toBeUndefined();
  });

  it.each([
    { schemaVersion: 2 }, { instanceId: "bad" }, { sourceRunId: "" }, { pluginVersion: "" },
    { pluginDigest: "abc" }, { componentDigest: "g".repeat(64) }, { status: "running" },
    { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: Infinity },
    { updatedAt: NaN }, { data: { value: Infinity } }, { surfaces: [] }, { surfaces: ["unknown"] }, { surfaces: new Array(1) },
    { activeActionRunId: "" }, { lastActionRunId: 1 }, { unknown: true },
  ])("rejects malformed instance %j", patch => {
    expect(readPluginUiInstance({ pluginUi: { ...instance, ...patch } })).toBeUndefined();
  });

  it.each([
    { schemaVersion: 2 }, { requestId: "bad" }, { requestFingerprint: "abc" }, { expectedRevision: -1 },
    { pluginId: "" }, { toolName: "" }, { toolUseId: "" }, { executionState: "running" },
    { args: { value: NaN } }, { unknown: true },
  ])("rejects malformed action %j", patch => {
    expect(readPluginUiAction({ uiAction: { ...action, ...patch } })).toBeUndefined();
  });

  it("validates all dismissal fields and optional action IDs", () => {
    const dismissal = { requestId, requestFingerprint: "d".repeat(64), expectedRevision: 0, revision: 1, dismissedAt: 3 };
    const dismissed = { ...instance, status: "dismissed", revision: 1, dismissal, activeActionRunId: "r2", lastActionRunId: "r1" };
    expect(readPluginUiInstance({ pluginUi: dismissed })).toEqual(dismissed);
    for (const patch of [{ requestId: "bad" }, { requestFingerprint: "bad" }, { expectedRevision: -1 }, { revision: 0.5 }, { dismissedAt: Infinity }, { extra: true }]) {
      expect(readPluginUiInstance({ pluginUi: { ...dismissed, dismissal: { ...dismissal, ...patch } } })).toBeUndefined();
    }
  });

  it("bounds UTF-8 instance data and action args and rejects deep data", () => {
    const data = { text: "中".repeat(87377) + "xx" }; // Exactly 262144 UTF-8 JSON bytes.
    expect(readPluginUiInstance({ pluginUi: { ...instance, data } })?.data).toEqual(data);
    expect(readPluginUiInstance({ pluginUi: { ...instance, data: { text: data.text + "x" } } })).toBeUndefined();
    expect(readPluginUiAction({ uiAction: { ...action, args: { text: "x".repeat(65536) } } })).toBeUndefined();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(readPluginUiInstance({ pluginUi: { ...instance, data: deep } })).toBeUndefined();
  });
});
