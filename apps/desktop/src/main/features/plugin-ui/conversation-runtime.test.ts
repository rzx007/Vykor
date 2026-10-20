import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { VykorClient } from "@vykor/client";
import { DesktopPluginUiService } from "./plugin-ui-service";
import { PluginUiDocumentStore } from "./document-store";
import { instance } from "../../../renderer/src/components/desktop/conversation-page/plugin-ui/__test__/plugin-ui-fixtures.test-support";

const input = { expectedRevision: 1, text: "继续分析", data: { selected: 1 } };
const requestId = "30000000-0000-4000-8000-000000000001";
function fixture(sourceSessionId = "session") {
  let sessionId = "session", version = 2, feature = 1, enabled = true;
  let childToken: object | undefined = {};
  const rootToken = {};
  let targetSessionId = "session";
  const source = { ...instance, sessionId: sourceSessionId };
  let receiptRevision = 2, posts = 0, queries = 0, documentReads = 0;
  let release: (() => void) | undefined, hold = false;
  const html = "<p>verified</p>";
  const receipt = (id = requestId) => ({ kind: "conversation", mode: "submit", instanceId: instance.instanceId,
    requestId: id, inputId: "input", runId: "run", revision: receiptRevision, status: "pending",
    ...(sourceSessionId !== "session" ? { targetSessionId } : {}) });
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path === "/capabilities") body = { serverVersion: "test", protocol: { version: 5 },
      features: { pluginUi: version, pluginUiLifecycle: 1, ...(feature ? { pluginUiConversation: feature } : {}) } };
    else if (path.endsWith("/document")) { documentReads++; body = { html, sha256: createHash("sha256").update(html).digest("hex") }; }
    else if (path.endsWith("/state")) body = { cursor: 1, session: { id: sourceSessionId, cwd: "/test", title: "", model: "test", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 }, inputs: [], messages: [], parts: [], runs: [], attempts: [], permissions: [] };
    else if (path.endsWith("/conversation/prepare")) {
      const submitted = JSON.parse(String(options?.body));
      body = { mode: submitted.mode, instanceId: instance.instanceId, revision: 1, promptText: "最终完整提示",
        ...(sourceSessionId !== "session" ? { targetSessionId } : {}) };
    } else if (path.endsWith("/conversation/submissions")) {
      const submitted = JSON.parse(String(options?.body));
      posts++; if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
      body = { receipt: receipt(submitted.requestId) };
    } else if (path.includes("/conversation/submissions/")) { queries++; body = { receipt: receipt(path.split("/").at(-1)) }; }
    else body = { instance: source, conversation: { draft: enabled, submit: enabled },
      availability: { code: "available", canRender: enabled, canInvoke: enabled }, actions: [] };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  } });
  const owner = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, getURL: () => "file:///trusted.html" });
  const service = new DesktopPluginUiService({ documents: new PluginUiDocumentStore(), getClient: async () => client,
    getOwnerSessionId: () => sessionId, localAvailable: () => true,
    ...(sourceSessionId !== "session" ? { getOwnerSessionToken: (ownerId: number, sid: string) =>
      ownerId !== 42 || sessionId !== "session" ? undefined : sid === "session" ? rootToken : sid === sourceSessionId ? childToken : undefined } : {}) });
  service.registerOwner(owner as never, "file:///trusted.html");
  const mount = () => service.mount(42, { sessionId: sourceSessionId === "session" ? sessionId : sourceSessionId, instanceId: instance.instanceId, surface: "tool-result" });
  const methods = service as unknown as Record<string, (...args: any[]) => Promise<any>>;
  return { service, owner, mount, methods, client, receipt, counts: () => ({ posts, queries, documentReads }),
    switchSession: () => { sessionId = "other"; service.invalidateOwner(42); },
    returnSession: () => { sessionId = "session"; service.invalidateOwner(42); },
    disable: () => { enabled = false; service.invalidateOwner(42); },
    version: (v: number, f = 1) => { version = v; feature = f; },
    receiptRevision: (v: number) => { receiptRevision = v; },
    target: (value: string) => { targetSessionId = value; },
    closeChild: () => { childToken = undefined; service.invalidateSession(42, sourceSessionId); },
    openChild: () => { childToken = {}; },
    hold: () => { hold = true; }, release: () => release?.() };
}
async function prepare(f: ReturnType<typeof fixture>, mountId: string) {
  expect(f.methods.prepareConversation).toBeTypeOf("function");
  return f.methods.prepareConversation!(42, { mountId, input: { mode: "submit", ...input } });
}
it("keeps an open child's submitted handoff bound while root snapshots arrive and retires it on aux close", async () => {
  const f = fixture("child"), mounted = await f.mount();
  expect(await prepare(f, mounted.mountId)).toMatchObject({ targetSessionId: "session" });
  f.hold();
  const pending = f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  const rejected = expect(pending).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  await new Promise(resolve => setTimeout(resolve, 10));
  f.service.observeSession(42, { syncStatus: "connected", session: { id: "session", status: "idle", metadata: {} }, parts: [] } as never);
  expect(await f.methods.getConversationSubmission!(42, { requestId })).toMatchObject({ requestId, targetSessionId: "session" });
  f.closeChild(); f.openChild();
  await expect(f.methods.getConversationSubmission!(42, { requestId })).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  f.release(); await rejected;
  expect(f.counts()).toMatchObject({ posts: 1, queries: 1 });
});
it("rejects a child handoff whose server target is outside the active root", async () => {
  const f = fixture("child"), mounted = await f.mount();
  f.target("unrelated");
  await expect(prepare(f, mounted.mountId)).rejects.toMatchObject({ code: "plugin_ui_invalid_message" });
  f.target("session"); await prepare(f, mounted.mountId);
  f.target("unrelated");
  await expect(f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input }))
    .rejects.toMatchObject({ code: "plugin_ui_invalid_message" });
});
it("prepares only a live owner mount and binds a submission before its POST resolves", async () => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  f.hold(); const pending = f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  await new Promise(resolve => setTimeout(resolve, 10));
  f.disable();
  expect(await f.methods.getConversationSubmission!(42, { requestId })).toMatchObject({ requestId, revision: 2 });
  expect(f.counts()).toEqual({ posts: 1, queries: 1, documentReads: 1 });
  f.release(); expect(await pending).toMatchObject({ requestId, revision: 2 });
});
it.each(["session", "connection", "window"])("releases queries after actual %s invalidation", async reason => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  await f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  if (reason === "session") f.switchSession(); else if (reason === "connection") f.service.invalidateConnection(); else f.owner.emit("destroyed");
  await expect(f.methods.getConversationSubmission!(42, { requestId })).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  expect(f.counts().queries).toBe(0);
});
it("rejects a new mount or changed JSON for an existing request identity", async () => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  await f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  await expect(f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input: { ...input, text: "different" } }))
    .rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
  f.service.unmount(42, { mountId: mounted.mountId });
  await expect(f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input })).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  expect(f.counts().posts).toBe(1);
});
it.each([[1, 1], [3, 1], [2, 0]])("refuses conversation handoff for protocol %i and feature %i", async (version, feature) => {
  const f = fixture(), mounted = await f.mount(); f.version(version, feature);
  await expect(prepare(f, mounted.mountId)).rejects.toMatchObject({ code: "plugin_ui_protocol_mismatch" });
});
it("retains sixteen unknown submissions and refuses the seventeenth without evicting the first", async () => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  f.receiptRevision(9);
  for (let i = 1; i <= 16; i++) await expect(f.methods.submitConversation!(42, { mountId: mounted.mountId,
    requestId: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, input })).rejects.toBeDefined();
  await expect(f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId: "30000000-0000-4000-8000-000000000017", input }))
    .rejects.toMatchObject({ code: "plugin_ui_too_many_requests" });
  f.receiptRevision(2); expect(await f.methods.getConversationSubmission!(42, { requestId })).toMatchObject({ requestId });
  expect(f.counts().posts).toBe(16);
});
it("closes business capabilities when the daemon lacks the exact conversation feature", async () => {
  const f = fixture(); f.version(2, 0);
  expect((await f.mount()).state.conversation).toEqual({ draft: false, submit: false });
});
it("releases only an admission matching the original source part and fingerprint", async () => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  await f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  const fingerprint = createHash("sha256").update('{"data":{"selected":1},"expectedRevision":1,"instanceId":"10000000-0000-4000-8000-000000000001","sessionId":"session","text":"继续分析"}').digest("hex");
  const view = { syncStatus: "connected", session: { id: "session", status: "idle", metadata: {} }, parts: [{ id: "part", metadata: { pluginUi: instance,
    pluginUiSubmission: { schemaVersion: 2, requestId, requestFingerprint: "f".repeat(64), expectedRevision: 1, inputId: "input", runId: "run", pluginDigest: instance.pluginDigest, componentDigest: instance.componentDigest, acceptedAt: 1 } } }] };
  f.service.observeSession(42, view as never);
  expect(await f.methods.getConversationSubmission!(42, { requestId })).toMatchObject({ requestId });
  view.parts[0]!.metadata.pluginUiSubmission.requestFingerprint = fingerprint;
  f.service.observeSession(42, view as never);
  await expect(f.methods.getConversationSubmission!(42, { requestId })).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
});
it("does not revive an old query after switching away from and back to its source session", async () => {
  const f = fixture(), mounted = await f.mount(); await prepare(f, mounted.mountId);
  f.hold(); const pending = f.methods.submitConversation!(42, { mountId: mounted.mountId, requestId, input });
  await new Promise(resolve => setTimeout(resolve, 10));
  f.switchSession(); f.returnSession();
  await expect(f.methods.getConversationSubmission!(42, { requestId })).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  expect(f.counts().queries).toBe(0);
  const rejected = expect(pending).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  f.release(); await rejected;
});
it.each(["session", "connection"])("keeps a new admission queryable when an old response arrives after %s replacement", async reason => {
  const f = fixture(), first = await f.mount(); await prepare(f, first.mountId);
  f.hold(); const old = f.methods.submitConversation!(42, { mountId: first.mountId, requestId, input });
  const oldRejected = expect(old).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  await new Promise(resolve => setTimeout(resolve, 10));
  if (reason === "session") { f.switchSession(); f.returnSession(); } else f.service.invalidateConnection();
  const current = await f.mount(), currentId = "30000000-0000-4000-8000-000000000002";
  await f.methods.submitConversation!(42, { mountId: current.mountId, requestId: currentId, input });
  f.release(); await oldRejected;
  expect(await f.methods.getConversationSubmission!(42, { requestId: currentId })).toMatchObject({ requestId: currentId });
  expect(f.counts()).toMatchObject({ posts: 2, queries: 1 });
});
