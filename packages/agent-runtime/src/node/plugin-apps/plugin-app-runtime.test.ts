import { expect, it } from "vitest";
import { PluginAppRuntime } from "./plugin-app-runtime.js";
import type { CapturedPluginAppBackend } from "./plugin-app-backends.js";
import type { PluginAppRecord } from "@vykor/protocol";

it("binds credentials to full immutable identity and original capture, and invalidates generation replacement", async () => {
  const app: PluginAppRecord = { id: "a", sessionId: "s", pluginId: "p", pluginVersion: "1", pluginDigest: "p",
    definitionDigest: "d", backendId: "b", backendKind: "native-tools", resourceUri: "ui://page", origin: { kind: "surface", surfaceId: "page" },
    logicalKey: "key", status: "open", controlRevision: 0, createdAt: 1, updatedAt: 1 };
  let generation = "g";
  const capture = (): CapturedPluginAppBackend => {
    const captured = generation;
    return { pluginId: "p", pluginVersion: "1", pluginDigest: "p", definitionDigest: "d",
      definition: { id: "b", kind: "native-tools", tools: [], resources: [{ uri: "ui://page", entry: "./page.html" }] },
      surfaces: [], tools: new Map(), isCurrentTool: () => false,
      port: { kind: "native-tools", generation: captured, isCurrent: () => generation === captured, supportsSubscriptions: false,
        readResource: async () => ({ contents: [] }), listResources: async () => ({ resources: [] }), listResourceTemplates: async () => ({ resourceTemplates: [] }) } };
  };
  const runtime = new PluginAppRuntime("s", { list: () => [], capture: async () => capture() });
  await runtime.host.refresh(app);
  const lease = runtime.host.issue(app, "g");
  await runtime.host.refresh(app);
  expect(runtime.host.issue(app, "g")).toEqual(lease);
  for (const patch of [{ sessionId: "other" }, { id: "other" }, { resourceUri: "ui://other" }, { definitionDigest: "other" },
    { pluginDigest: "other" }, { pluginVersion: "2" }, { backendId: "other" }, { logicalKey: "other" }])
    expect(runtime.host.validate({ ...app, ...patch }, lease, "g")).toBe(false);
  generation = "next";
  expect(runtime.host.validate(app, lease, "g")).toBe(false);
  await runtime.host.refresh(app);
  expect(runtime.host.issue(app, "next").token).not.toBe(lease.token);
  runtime.host.clear();
  expect(() => runtime.host.issue(app, "next")).toThrow();
});
