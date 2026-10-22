import { type AgentEventInput } from "@vykor/agent-contracts";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getInstalledPluginStorePath } from "@vykor/host-config";
import { QueryEngine } from "@vykor/core";
import { HookExecutor } from "@vykor/hooks";
import { nativeToolResultToAppResult } from "./native-plugin-app-backend.js";
import { updateInstalledPluginStore } from "@vykor/plugins";
import type { PluginAppHostBinding, PluginAppHostInvocation } from "@vykor/plugin-contracts/runtime";
import { createDefaultNodeAgent } from "../runtime/default-agent.js";
import { installAppFixture, appFixtureSettings } from "../../../test-helpers/plugin-app-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture(kind: "native-tools" | "mcp-server", autosave = false, mode: "default" | "plan" | "full_auto" = "full_auto") {
  const root = mkdtempSync(join(tmpdir(), "app-agent-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const installed = await installAppFixture(root, kind, undefined, false, autosave);
  const model = vi.fn();
  const requestPermission = vi.fn(async () => ({ status: "denied" as const }));
  const agent = await createDefaultNodeAgent({ cwd: root, sessionId: "session", settings: { ...appFixtureSettings, permission: { mode } }, effects: { requestPermission },
    capabilityOverrides: { terminal: false, memory: false },
    client: { async *streamMessage() { model(); throw new Error("Unexpected model"); } } });
  cleanup.push(() => agent.close());
  const descriptor = agent.host.plugins.pluginApps.list()[0]!;
  const app: PluginAppHostBinding = { instanceId: "app", agentId: agent.id, sessionId: agent.id, ...descriptor, resourceUri: "ui://fixture/panel.html" };
  const facts = await agent.host.plugins.pluginApps.refresh(app);
  const lease = agent.host.plugins.pluginApps.issue(app, facts.backendGeneration!);
  const request: PluginAppHostInvocation = { binding: app, lease, toolName: installed.toolName, args: { value: "approved" } };
  const scope = { agentId: agent.id, sessionId: agent.id, runId: "run", inputId: "run", traceId: "run", cwd: root, signal: new AbortController().signal };
  return { agent, app, request, scope, model, requestPermission, ...installed, effects: () => existsSync(installed.effectFile) ? Number(readFileSync(installed.effectFile, "utf8")) : 0 };
}
it.each(["native-tools", "mcp-server"] as const)("uses installed %s autosave approval only for the original app and exact argument limit", async kind => {
  const h = await fixture(kind, true, "default");
  expect((await h.agent.host.plugins.pluginApps.prepareTool(h.request)).policy).toEqual({ confirmation: "granted", authorization: "plugin-data-write", maxArgumentsBytes: 2 * 1024 * 1024 });
  const large = { ...h.request, args: { value: "x".repeat(100_000) } };
  expect((await h.agent.host.plugins.runPluginAppTool(large, { scope: h.scope })).executionState).toBe("completed");
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.effects()).toBe(1);
  await expect(h.agent.host.plugins.runPluginAppTool({ ...large, args: { value: "x".repeat(2 * 1024 * 1024) } }, { scope: h.scope })).rejects.toThrow("too_large");
  expect(h.agent.host.plugins.listModelVisibleTools().some(tool => tool.name === h.toolName)).toBe(false);
  await updateInstalledPluginStore(getInstalledPluginStorePath(), store => { Object.values(store.plugins).forEach(p => { p.approvedPermissions = p.approvedPermissions.filter(permission => permission !== "pluginData:write"); }); });
  await expect(h.agent.host.plugins.pluginApps.prepareTool(h.request)).rejects.toThrow();
  expect(h.effects()).toBe(1);
}, 30_000);
it.each(["native-tools", "mcp-server"] as const)("keeps ordinary %s tools bounded and preserves the plan ceiling", async kind => {
  const ordinary = await fixture(kind, false, "default");
  await expect(ordinary.agent.host.plugins.pluginApps.prepareTool({ ...ordinary.request, args: { value: "x".repeat(100_000) } })).rejects.toThrow("too_large");
  expect((await ordinary.agent.host.plugins.runPluginAppTool(ordinary.request, { scope: ordinary.scope })).failureKind).toBe("permission");
  expect(ordinary.requestPermission).toHaveBeenCalledOnce();
  const plan = await fixture(kind, true, "plan");
  expect((await plan.agent.host.plugins.runPluginAppTool(plan.request, { scope: plan.scope })).failureKind).toBe("permission");
  expect(plan.effects()).toBe(0); expect(plan.requestPermission).not.toHaveBeenCalled();
}, 30_000);
it.each(["native-tools", "mcp-server"] as const)("runs one original %s binding without model calls or history", async kind => {
  const h = await fixture(kind);
  expect(h.agent.host.plugins.listModelVisibleTools().some(t => t.name === h.toolName)).toBe(false);
  const result = await h.agent.host.plugins.runPluginAppTool(h.request, { scope: h.scope });
  expect(result.executionState).toBe("completed"); expect(h.effects()).toBe(1); expect(h.model).not.toHaveBeenCalled();
  expect(h.agent.getHistory()).toEqual([]);
}, 30_000);
it.each(["native-tools", "mcp-server"] as const)("rejects forged source, tool, lease and disabled %s without calling", async kind => {
  const h = await fixture(kind);
  for (const request of [
    { ...h.request, binding: { ...h.request.binding, sessionId: "foreign" } },
    { ...h.request, toolName: "Read" },
    { ...h.request, lease: { ...h.request.lease, token: "forged" } },
  ]) await expect(h.agent.host.plugins.runPluginAppTool(request, { scope: h.scope })).rejects.toThrow();
  await updateInstalledPluginStore(getInstalledPluginStorePath(), store => { Object.values(store.plugins).forEach(p => { p.enabled = false; }); });
  await expect(h.agent.host.plugins.runPluginAppTool(h.request, { scope: h.scope })).rejects.toThrow();
  expect(h.effects()).toBe(0); expect(h.model).not.toHaveBeenCalled();
}, 30_000);
it.each(["native-tools", "mcp-server"] as const)("rechecks %s installation at the before-invoke boundary", async kind => {
  const h = await fixture(kind);
  await expect(h.agent.host.plugins.runPluginAppTool(h.request, { scope: h.scope, onToolEvent: async event => {
    if (event.type === "tool.started") await updateInstalledPluginStore(getInstalledPluginStorePath(), store => {
      Object.values(store.plugins).forEach(p => { p.approvedPermissions = []; });
    });
  } })).rejects.toThrow();
  expect(h.effects()).toBe(0); expect(h.model).not.toHaveBeenCalled();
}, 30_000);

it.each(["post-hook", "terminal-lifecycle", "result-save"])("delivers the real Native result once and propagates %s failure", async failureAt => {
  const h = await fixture("native-tools"), failure = new Error(failureAt), completed: AgentEventInput[] = [];
  if (failureAt === "post-hook") vi.spyOn(HookExecutor.prototype, "execute").mockImplementation(async event => {
    if (event === "post_tool_use") throw failure; return { blocked: false };
  });
  await expect(h.agent.host.plugins.runPluginAppTool({ ...h.request, args: { value: "forge" } }, { scope: h.scope, onToolEvent: async event => {
    if (event.type === "tool.completed") { completed.push(event); if (failureAt === "result-save") throw failure; }
    if (failureAt === "terminal-lifecycle" && event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "failed") throw failure;
  } })).rejects.toBe(failure);
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ data: { result: { content: [{ type: "text", text: "Saved" }], isError: true, executionState: "completed", metadata: { appData: { value: "forge" } } } } });
  expect(h.effects()).toBe(1); expect(h.model).not.toHaveBeenCalled();
}, 30_000);
it("supports a custom QueryEngine returning without the optional delivery callback", async () => {
  const h = await fixture("native-tools"), onToolEvent = vi.fn(async (_event: AgentEventInput) => {});
  vi.spyOn(QueryEngine.prototype, "executeTool").mockResolvedValue({ toolUseId: "custom", toolName: h.toolName, content: [], executionState: "completed" });
  await h.agent.host.plugins.runPluginAppTool(h.request, { scope: h.scope, onToolEvent });
  expect(onToolEvent.mock.calls.filter(([event]) => event.type === "tool.completed")).toHaveLength(1);
  expect(h.effects()).toBe(0);
}, 30_000);
it.each(["mcp-malformed", "mcp-oversized", "mcp-valid", "invalid-app-data"])("isolates Native %s from checked execution and page conversion", async value => {
  const h = await fixture("native-tools");
  const completed: AgentEventInput[] = [];
  const original = await h.agent.host.plugins.runPluginAppTool({ ...h.request, args: { value } }, { scope: h.scope, onToolEvent: async event => { if (event.type === "tool.completed") completed.push(event); } });
  expect(original).toMatchObject({ content: [{ type: "text", text: "Saved" }], executionState: "completed" });
  expect(original).not.toHaveProperty("mcpResult"); expect(original.isError).toBeFalsy();
  const view = nativeToolResultToAppResult(original);
  expect(view.result.content).toEqual([{ type: "text", text: "Saved" }]);
  expect(view.result).not.toHaveProperty("_meta");
  if (value === "invalid-app-data") { expect(view.dataError).toBe("plugin_app_invalid_data"); expect(view.result).not.toHaveProperty("structuredContent"); }
  else expect(view.result.structuredContent).toEqual({ value });
  expect(completed).toHaveLength(1); expect(h.effects()).toBe(1); expect(h.model).not.toHaveBeenCalled();
}, 30_000);
