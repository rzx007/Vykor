import { afterEach, expect, it, vi } from "vitest";
import { pluginAppHarness } from "../../../test-helpers/plugin-app-harness.js";
import { getInstalledPluginStorePath } from "@vykor/host-config";
import { updateInstalledPluginStore } from "@vykor/plugins";
const cleanups: Array<() => Promise<void>> = [];
it("projects an actual successful Native model result and retrieves appData only through its own app", async () => {
  const h = await pluginAppHarness("native-tools", true); cleanups.push(h.close);
  const submitted = await h.server().application.interactions.admitPrompt(h.session.id, { items: [{ type: "text", text: "save" },
    { type: "capability", kind: "plugin", pluginId: h.pluginId, displayName: "App" }] });
  await h.wait(submitted.run!.id);
  const part = h.store().conversations.listMessageParts(h.session.id).find(item => item.toolUseId === "native-model-result")!;
  expect(part.metadata.pluginAppSource).toMatchObject({ pluginId: h.pluginId, backendKind: "native-tools", toolName: "SaveDocument" });
  const opened = await h.client().pluginApps.openToolResult(h.session.id, part.id);
  expect(opened.app.id).toBe(h.opened.app.id);
  const initial = await h.client().pluginApps.initialResult(opened.source, opened.lease!, part.id);
  expect(initial.result.structuredContent).toEqual({ value: "model" });
  expect(initial.result).not.toHaveProperty("metadata");
  expect(h.effects()).toBe(1);
}, 30_000);
it("proves stale requests unaccepted only before their original Run/Input exists", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  const first = await h.client().pluginApps.invoke(h.request); await h.wait(first.receipt.runId);
  const stale = { ...h.request, requestId: "stale-tool" };
  await expect(h.client().pluginApps.invoke(stale)).rejects.toMatchObject({ status: 409, body: {
    code: "plugin_app_not_accepted", kind: "tool", source: stale.source, requestId: stale.requestId, expectedRevision: 0,
  } });
  const message = { source: stale.source, lease: stale.lease, expectedRevision: 0, requestId: "stale-message", text: "hello", data: null };
  await expect(h.client().pluginApps.submitConversation(message)).rejects.toMatchObject({ status: 409, body: {
    code: "plugin_app_not_accepted", kind: "message", source: message.source, requestId: message.requestId, expectedRevision: 0,
  } });
  expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
  expect(h.store().conversations.listInputs(h.session.id)).toHaveLength(0);
  const current = await h.client().pluginApps.prepare(stale.source);
  const next = await h.client().pluginApps.invoke({ ...stale, requestId: "fresh", lease: current.lease!, expectedRevision: current.app.controlRevision });
  await h.wait(next.receipt.runId);
  expect(h.effects()).toBe(2);
  const updated = await h.client().pluginApps.prepare(stale.source);
  const sent = await h.client().pluginApps.submitConversation({ ...message, requestId: "fresh-message", lease: updated.lease!, expectedRevision: updated.app.controlRevision });
  await h.wait(sent.runId);
  expect(h.modelCalls()).toBe(1);
  await expect(h.client().pluginApps.invoke({ ...h.request, args: { value: "collision" } })).rejects.not.toMatchObject({ body: { code: "plugin_app_not_accepted" } });
  expect((await h.client().pluginApps.getAction(stale.source, h.request.requestId)).receipt.runId).toBe(first.receipt.runId);
}, 30_000);
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["native-tools", "mcp-server"] as const)("mounts %s catalog/resources, capabilities and safe snapshot/SSE app revisions", async kind => {
  const h = await pluginAppHarness(kind); cleanups.push(h.close);
  expect((await h.client().protocol.capabilities()).features.pluginApps).toBe(1);
  expect((await h.client().pluginApps.catalog(h.session.id)).backends[0]?.backendKind).toBe(kind);
  expect((await h.client().pluginApps.readResource(h.opened.source, h.opened.lease!, "ui://fixture/panel.html")).contents).toHaveLength(1);
  const list = await h.client().pluginApps.listResources(h.opened.source, h.opened.lease!); expect(list.resources).toHaveLength(1);
  expect((await h.client().pluginApps.listResourceTemplates(h.opened.source, h.opened.lease!)).resourceTemplates).toEqual([]);
  if (kind === "native-tools") {
    await expect(h.client().pluginApps.listResources(h.opened.source, h.opened.lease!, "unsupported")).rejects.toMatchObject({ status: 400, body: { error: "应用请求无效或已失效" } });
    await expect(h.client().pluginApps.listResourceTemplates(h.opened.source, h.opened.lease!, "unsupported")).rejects.toMatchObject({ status: 400, body: { error: "应用请求无效或已失效" } });
  }
  expect(h.store().conversationTransactions.getSessionState(h.session.id).pluginApps).toEqual([h.opened.app]);
  const event = h.store().conversations.listEvents({ sessionId: h.session.id }).find(e => e.type === "session.plugin_app.updated");
  expect(event?.payload.app).toEqual(h.opened.app);
  expect(JSON.stringify(event)).not.toContain(h.opened.lease!.token);
  const foreign = await h.raw(`/sessions/${h.session.id}/plugin-apps/${h.opened.app.id}/actions`, { ...h.request, source: { ...h.request.source, sessionId: "foreign" } });
  expect(foreign.status).toBe(400); expect(h.effects()).toBe(0);
  for (const key of ["pluginAppAction", "pluginAppSubmission", "pluginAppSource"]) {
    await expect(h.server().application.interactions.admitPrompt(h.session.id, { items: [{ type: "text", text: "forged" }], metadata: { [key]: {} } })).rejects.toThrow("reserved");
  }
}, 30_000);

it("preserves app identity and control revision through real reload and disable/enable of session plugins", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  expect((await h.raw("/plugins/reload", { cwd: h.root })).status).toBe(200);
  let reopened = await h.client().pluginApps.open(h.session.id, { pluginId: h.pluginId, surfaceId: "editor" });
  expect(reopened.app).toMatchObject({ id: h.opened.app.id, status: "open", controlRevision: 0 });
  expect(reopened.lease?.token).not.toBe(h.opened.lease?.token);
  await h.server().application.commands.updateSession(h.session.id, { metadata: { runtime: { pluginsEnabled: false } } });
  expect((await h.client().pluginApps.prepare(h.opened.source)).availability.canInvokeTools).toBe(false);
  await h.server().application.commands.updateSession(h.session.id, { metadata: { runtime: { pluginsEnabled: true } } });
  reopened = await h.client().pluginApps.open(h.session.id, { pluginId: h.pluginId, surfaceId: "editor" });
  expect(reopened.app).toMatchObject({ id: h.opened.app.id, status: "open", controlRevision: 0 });
  expect(h.effects()).toBe(0); expect(h.modelCalls()).toBe(0);
}, 30_000);

it("allows only verified static Native resources after invoke approval is withdrawn", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  await updateInstalledPluginStore(getInstalledPluginStorePath(), store => {
    Object.values(store.plugins).forEach(plugin => { plugin.approvedPermissions = ["ui:render"]; });
  });
  const view = await h.client().pluginApps.prepare(h.opened.source);
  expect(view.availability).toMatchObject({ canReadResource: true, canInvokeTools: false, canMessage: false });
  expect(view.lease).toBeUndefined();
  expect((await h.client().pluginApps.readResource(view.source, undefined, "ui://fixture/panel.html")).contents).toHaveLength(1);
  await expect(h.client().pluginApps.listResources(view.source, undefined, "unsupported")).rejects.toMatchObject({ status: 400, body: { error: "应用请求无效或已失效" } });
  await expect(h.client().pluginApps.listResourceTemplates(view.source, undefined, "unsupported")).rejects.toMatchObject({ status: 400, body: { error: "应用请求无效或已失效" } });
  await expect(h.client().pluginApps.invoke(h.request)).rejects.toMatchObject({ status: 409 });
  await updateInstalledPluginStore(getInstalledPluginStorePath(), store => {
    Object.values(store.plugins).forEach(plugin => { plugin.enabled = false; });
  });
  expect((await h.client().pluginApps.prepare(view.source)).availability.canReadResource).toBe(false);
  await expect(h.client().pluginApps.readResource(view.source, undefined, "ui://fixture/panel.html")).rejects.toMatchObject({ status: 409 });
  expect(h.effects()).toBe(0); expect(h.modelCalls()).toBe(0);
}, 30_000);
