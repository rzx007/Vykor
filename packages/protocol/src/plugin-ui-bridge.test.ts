import { describe, expect, it } from "vitest";
import {
  decodePluginUiBridgeMessage, encodePluginUiBridgeMessage,
  parsePluginUiBridgeRequest, parsePluginUiBridgeSnapshot, readPluginUiBridgeResponse,
} from "./plugin-ui-bridge.js";

const instanceId = "10000000-0000-4000-8000-000000000001";
const mountId = "20000000-0000-4000-8000-000000000001";
const snapshot = {
  instanceId, revision: 1, status: "open", data: { count: 1 },
  actions: [{ id: "apply", label: "应用", completion: "keep-open" }],
  readOnly: false, theme: "light", locale: "zh-CN", surface: "tool-result",
};
const request = {
  version: 1, mountId, id: "one", method: "requestAction",
  params: { actionId: "apply", args: { text: "before" }, expectedRevision: 1 },
};

describe("Plugin UI bridge boundaries", () => {
  it("reads only the finite methods and exact action parameters", () => {
    expect(parsePluginUiBridgeRequest(request)).toEqual(request);
    for (const params of [
      { ...request.params, approved: true }, { ...request.params, toolName: "Shell" },
      { ...request.params, args: { n: NaN } }, { ...request.params, expectedRevision: -1 },
    ]) expect(() => parsePluginUiBridgeRequest({ ...request, params })).toThrow();
    expect(() => parsePluginUiBridgeRequest({ ...request, method: "executeTool" }))
      .toThrow("plugin_ui_method_not_supported");
  });

  it.each([{ version: undefined }, { version: 2 }, { mountId: "forged" }, { id: "" }, { id: "x".repeat(81) },
    { extra: true }])("rejects malformed request identity %j", changes => {
    expect(() => parsePluginUiBridgeRequest({ ...request, ...changes })).toThrow();
  });

  it("accepts boundary heights, rejecting non-finite or out-of-range display requests", () => {
    for (const height of [160, 320.5, 640])
      expect(parsePluginUiBridgeRequest({ ...request, method: "resize", params: { height } }).params).toEqual({ height });
    for (const height of [159, 641, NaN, Infinity, "320"])
      expect(() => parsePluginUiBridgeRequest({ ...request, method: "resize", params: { height } })).toThrow();
  });

  it("owns snapshots and does not pass extra host identity or full results", () => {
    expect(parsePluginUiBridgeSnapshot(snapshot)).toEqual(snapshot);
    const copy = parsePluginUiBridgeSnapshot(snapshot);
    copy.data.count = 9;
    expect(snapshot.data.count).toBe(1);
    for (const extra of [{ sessionId: "private" }, { toolInput: {} }, { result: "raw" }])
      expect(() => parsePluginUiBridgeSnapshot({ ...snapshot, ...extra })).toThrow();
    expect(() => parsePluginUiBridgeSnapshot({ ...snapshot, actions: [...snapshot.actions, ...snapshot.actions] })).toThrow();
  });

  it("requires actual enum strings, not arrays or objects with the same string form", () => {
    for (const changes of [
      { status: ["open"] }, { theme: ["light"] }, { surface: ["tool-result"] },
      { actions: [{ id: "apply", label: "应用", completion: ["keep-open"] }] },
    ]) expect(() => parsePluginUiBridgeSnapshot({ ...snapshot, ...changes })).toThrow();
    expect(readPluginUiBridgeResponse({
      version: 1, mountId, id: "one", result: {
        requestId: "30000000-0000-4000-8000-000000000001", runId: "run", instanceId,
        revision: 2, status: ["pending"],
      },
    })).toBeUndefined();
  });

  it("rejects sparse/non-JSON data and oversized Unicode without truncating", () => {
    for (const args of [{ v: Infinity }, { v: undefined }, { v: new Date() }, { v: [, 1] }])
      expect(() => parsePluginUiBridgeRequest({ ...request, params: { ...request.params, args } })).toThrow();
    expect(() => parsePluginUiBridgeRequest({
      ...request, params: { ...request.params, args: { text: "中".repeat(22_000) } },
    })).toThrow("plugin_ui_payload_too_large");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parsePluginUiBridgeRequest({ ...request, params: { ...request.params, args: cyclic } })).toThrow();
  });

  it("limits domain depth without incorrectly counting packet wrappers", () => {
    let args: Record<string, unknown> = { leaf: true };
    for (let i = 1; i < 20; i++) args = { child: args };
    expect(parsePluginUiBridgeRequest({ ...request, params: { ...request.params, args } })).toBeDefined();
    expect(() => parsePluginUiBridgeRequest({
      ...request, params: { ...request.params, args: { child: args } },
    })).toThrow();
  });

  it("bounds wire text before parsing and permits only declared response shapes", () => {
    const wire = encodePluginUiBridgeMessage(request);
    expect(JSON.parse(wire)).toEqual(request);
    expect(decodePluginUiBridgeMessage(wire)).toEqual(request);
    expect(() => decodePluginUiBridgeMessage(" ".repeat(65_537))).toThrow("plugin_ui_payload_too_large");
    expect(() => decodePluginUiBridgeMessage(request)).toThrow("plugin_ui_invalid_message");
    expect(readPluginUiBridgeResponse({ version: 1, mountId, id: "one", result: snapshot })).toBeDefined();
    expect(readPluginUiBridgeResponse({ version: 1, mountId, id: "one", result: null, error: { code: "bad" } })).toBeUndefined();
    expect(readPluginUiBridgeResponse({ version: 1, mountId, id: "one", result: { sessionId: "private" } })).toBeUndefined();
  });
});
