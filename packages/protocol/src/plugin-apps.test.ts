import { describe, expect, it } from "vitest";
import { PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";
import { copyPluginAppJson, parsePluginAppToolRequest, isPluginAppAdmissionRejection, readPluginAppAction } from "./plugin-apps.js";

describe("plugin app wire data", () => {
  it("copies bounded finite JSON and rejects executable or lossy values", () => {
    const input = { draft: [1, true, null, "文"] };
    const copy = copyPluginAppJson(input, 1024);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    for (const value of [NaN, Infinity, undefined, new Date(), { x: undefined }, { get x() { throw new Error("getter"); } }]) {
      expect(() => copyPluginAppJson(value, 1024)).toThrow();
    }
    expect(() => copyPluginAppJson({ text: "文".repeat(20) }, 20)).toThrow();
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => copyPluginAppJson(cycle, 1024)).toThrow();
  });

  it("keeps the original host source, lease and expected revision", () => {
    const request = {
      requestId: "request", expectedRevision: 7, toolName: "save", args: { value: 1 },
      source: { sessionId: "session", appId: "app" },
      lease: { token: "opaque", backendGeneration: "generation" },
    };
    expect(parsePluginAppToolRequest(request)).toEqual(request);
    expect(() => parsePluginAppToolRequest({ ...request, expectedRevision: -1 })).toThrow();
    expect(() => parsePluginAppToolRequest({ ...request, targetTool: "foreign" })).toThrow();
    expect(() => parsePluginAppToolRequest({ ...request, args: [] })).toThrow();
  });

  it("admits large JSON at the wire boundary for a later trusted tool policy check", () => {
    const request = { requestId: "r", expectedRevision: 0, toolName: "save", args: { text: "x".repeat(100_000) },
      source: { sessionId: "s", appId: "a" }, lease: { token: "t", backendGeneration: "g" } };
    expect(parsePluginAppToolRequest(request).args).toEqual(request.args);
    expect(() => parsePluginAppToolRequest({ ...request, policy: { confirmation: "granted" } })).toThrow();
    const metadata = { schemaVersion: 1, source: request.source, requestId: "r", requestFingerprint: "fp", expectedRevision: 0, acceptedRevision: 1,
      pluginId: "p", pluginVersion: "1", pluginDigest: "p", definitionDigest: "d", backendId: "b", backendKind: "mcp-server",
      resourceUri: "ui://page", toolName: "save", registeredToolName: "mcp__s__save", toolUseId: "call", args: request.args, executionState: "completed" };
    expect(readPluginAppAction({ pluginAppAction: metadata })?.args).toEqual(request.args);
    expect(() => parsePluginAppToolRequest({ ...request, args: { text: "x".repeat(PLUGIN_APP_DATA_LIMITS.maxArgsBytes) } })).toThrow("too_large");
  });
  it("accepts old or explicit busy rejection proof and rejects an invented reason", () => {
    const request = { source: { sessionId: "s", appId: "a" }, requestId: "r", expectedRevision: 1 };
    const rejection = { ...request, code: "plugin_app_not_accepted", kind: "tool" };
    expect(isPluginAppAdmissionRejection(rejection, "tool", request)).toBe(true);
    expect(isPluginAppAdmissionRejection({ ...rejection, reason: "busy" }, "tool", request)).toBe(true);
    expect(isPluginAppAdmissionRejection({ ...rejection, reason: "invented" }, "tool", request)).toBe(false);
  });
});
