import { describe, expect, it } from "vitest";
import { copyPluginAppJson, parsePluginAppToolRequest } from "./plugin-apps.js";

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
});
