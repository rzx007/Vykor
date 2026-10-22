import { expect, it } from "vitest";
import { PluginAppRuntime } from "./plugin-app-runtime.js";
import type { CapturedPluginAppBackend } from "./plugin-app-backends.js";
import type { PluginAppHostBinding } from "@vykor/plugin-contracts/runtime";

it("binds credentials to full immutable identity and original capture, and invalidates generation replacement", async () => {
  const app: PluginAppHostBinding = { instanceId: "a", agentId: "s", sessionId: "s", pluginId: "p", pluginVersion: "1", pluginDigest: "p",
    definitionDigest: "d", backendId: "b", backendKind: "native-tools", resourceUri: "ui://page" };
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
  for (const patch of [{ sessionId: "other" }, { instanceId: "other" }, { resourceUri: "ui://other" }, { definitionDigest: "other" },
    { pluginDigest: "other" }, { pluginVersion: "2" }, { backendId: "other" }, { agentId: "other" }])
    expect(runtime.host.validate({ ...app, ...patch }, lease, "g")).toBe(false);
  const sibling = { ...app, instanceId: "b" };
  await runtime.host.refresh(sibling);
  const siblingLease = runtime.host.issue(sibling, "g");
  expect(siblingLease.token).not.toBe(lease.token);
  expect(runtime.host.validate(sibling, lease, "g")).toBe(false);
  runtime.host.revoke({ sessionId: "s", instanceId: "a" });
  expect(runtime.host.validate(sibling, siblingLease, "g")).toBe(true);
  expect(runtime.host.validate(app, lease, "g")).toBe(false);
  await runtime.host.refresh(app);
  expect(runtime.host.issue(app, "g").token).not.toBe(lease.token);
  generation = "next";
  expect(runtime.host.validate(app, lease, "g")).toBe(false);
  await runtime.host.refresh(app);
  expect(runtime.host.issue(app, "next").token).not.toBe(lease.token);
  runtime.host.clear();
  expect(() => runtime.host.issue(app, "next")).toThrow();
});
