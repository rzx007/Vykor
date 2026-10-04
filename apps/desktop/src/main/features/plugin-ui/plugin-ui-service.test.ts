import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { VykorClient, type PluginUiInstanceRecord } from "@vykor/client";
import type { WebContents } from "electron";
import { PluginUiDocumentStore } from "./document-store";
import { DesktopPluginUiService } from "./plugin-ui-service";

const instanceId = "10000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const instance: PluginUiInstanceRecord = {
  schemaVersion: 1, instanceId, sessionId: "session", sourceRunId: "source", sourcePartId: "part",
  sourceToolUseId: "use", sourceToolName: "Inspect", pluginId: "example.ui", pluginVersion: "1",
  pluginDigest: "a".repeat(64), componentId: "card", componentDigest: "b".repeat(64),
  title: "检查结果", surfaces: ["tool-result", "session-sidebar"], status: "open", revision: 1,
  data: { count: 1 }, createdAt: 1, updatedAt: 1,
};
const ownerView = (generation: string, present = true) => ({ cursor: 1, syncStatus: "connected",
  session: { id: "session", status: "idle", metadata: { pluginUiGeneration: generation } },
  parts: present ? [{ id: "part", metadata: { pluginUi: instance } }] : [], runs: [],
});
const otherInstance = { ...instance, instanceId: "10000000-0000-4000-8000-000000000002", sourcePartId: "other-part" };
function fixture() {
  let currentSession: string | undefined = "session";
  let lifecycle = true;
  let releaseDocument: (() => void) | undefined;
  let enteredDocument!: () => void;
  const documentEntered = new Promise<void>(resolve => { enteredDocument = resolve; });
  let holdDocument = false;
  let drift = false; let documentRead = false;
  let changeGeneration = false;
  const submissions: unknown[] = [];
  const html = "<p>private verified document</p>";
  const client = new VykorClient({ baseUrl: "http://127.0.0.1:4000", fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path === "/capabilities") body = { serverVersion: "test", protocol: { version: 5 },
      features: { pluginUi: 1, ...(lifecycle ? { pluginUiLifecycle: 1 } : {}) } };
    else if (path.endsWith("/document")) {
      documentRead = true;
      enteredDocument();
      if (holdDocument) {
        holdDocument = false;
        await new Promise<void>(resolve => { releaseDocument = resolve; });
      }
      body = { html, sha256: createHash("sha256").update(html).digest("hex") };
    } else if (path.endsWith("/state")) body = { cursor: 1,
      session: { id: "session", cwd: "/test", title: "", model: "test", status: "idle",
        metadata: { pluginUiGeneration: changeGeneration && documentRead ? "next" : "first" }, createdAt: 1, updatedAt: 1 },
      inputs: [], messages: [], parts: [], runs: [], attempts: [], permissions: [] };
    else if (path.endsWith("/actions")) {
      submissions.push(JSON.parse(String(options?.body)));
      body = { receipt: { instanceId, requestId, runId: "ui_run_once", revision: 2, status: "pending" } };
    } else if (path.endsWith("/dismiss")) { submissions.push("dismiss"); body = { instance: { ...instance, status: "dismissed", revision: 2 } }; }
    else {
      const current = path.endsWith("/" + otherInstance.instanceId) ? otherInstance : instance;
      body = { instance: drift && documentRead ? { ...current, componentDigest: "c".repeat(64) } : current,
      availability: { code: "available", canRender: true, canInvoke: true },
      actions: [{ id: "apply", label: "应用", toolName: "Inspect", inputSchema: {}, completion: "keep-open" }] };
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  } });
  let ownerUrl = "file:///trusted.html";
  const owner = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, getURL: () => ownerUrl });
  const documents = new PluginUiDocumentStore();
  const service = new DesktopPluginUiService({
    documents, getClient: async () => client, getOwnerSessionId: () => currentSession,
    localAvailable: () => true,
  });
  service.registerOwner(owner as unknown as WebContents, "file:///trusted.html");
  return { service, documents, owner, submissions, html, documentEntered,
    setSession: (id?: string) => { currentSession = id; service.invalidateOwner(42); },
    withoutLifecycle: () => { lifecycle = false; },
    holdDocument: () => { holdDocument = true; },
    driftDocument: () => { drift = true; },
    changeGeneration: () => { changeGeneration = true; },
    navigateOwner: () => { ownerUrl = "https://foreign.invalid/"; },
    releaseDocument: () => releaseDocument?.() };
}

it("mounts only verified current data and invokes the declared action with the original request identity", async () => {
  const f = fixture();
  const mount = await f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" });
  expect(mount.url).toMatch(/^vykor-plugin-ui:\/\/frame\/[a-f0-9-]+$/);
  expect(JSON.stringify(mount)).not.toContain(f.html);
  expect(mount.state.snapshot.data).toEqual({ count: 1 });
  expect(mount.state.snapshot).not.toHaveProperty("sessionId");
  const receipt = await f.service.invokeAction(42, { mountId: mount.mountId,
    input: { requestId, expectedRevision: 1, actionId: "apply", args: { text: "before" } } });
  expect(receipt.requestId).toBe(requestId);
  expect(f.submissions).toEqual([{ requestId, expectedRevision: 1, actionId: "apply", args: { text: "before" } }]);
  f.service.unmount(42, { mountId: mount.mountId });
  expect(f.documents.owns(mount.mountId, 42)).toBe(false);
  expect(f.submissions).toHaveLength(1);
});
it.each([
  ["tool-result", "tool-result"], ["session-sidebar", "session-sidebar"],
  ["tool-result", "session-sidebar"], ["session-sidebar", "tool-result"],
] as const)(
  "does not let a delayed %s load revoke the newer %s display", async (surface, nextSurface) => {
    const f = fixture(); f.holdDocument();
    const first = f.service.mount(42, { sessionId: "session", instanceId, surface });
    const rejected = expect(first).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
    await f.documentEntered;
    const current = await f.service.mount(42, { sessionId: "session", instanceId, surface: nextSurface });
    f.releaseDocument();
    await rejected;
    expect(f.documents.owns(current.mountId, 42)).toBe(true);
    expect(f.documents.allowNavigation(42, 99, current.url, false)).toBe(true);
  }
);
it("keeps the newest sidebar when a different instance's earlier load returns late", async () => {
  const f = fixture(); f.holdDocument();
  const first = f.service.mount(42, { sessionId: "session", instanceId, surface: "session-sidebar" });
  const rejected = expect(first).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  await f.documentEntered;
  const current = await f.service.mount(42, { sessionId: "session", instanceId: otherInstance.instanceId, surface: "session-sidebar" });
  f.releaseDocument(); await rejected;
  expect(f.documents.owns(current.mountId, 42)).toBe(true);
});
it("still allows independent inline instances to finish loading in either order", async () => {
  const f = fixture(); f.holdDocument();
  const first = f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" });
  await f.documentEntered;
  const second = await f.service.mount(42, { sessionId: "session", instanceId: otherInstance.instanceId, surface: "tool-result" });
  f.releaseDocument();
  expect(f.documents.owns((await first).mountId, 42)).toBe(true);
  expect(f.documents.owns(second.mountId, 42)).toBe(true);
});
it.each(["generation", "source", "reconnecting"] as const)("revokes a mounted document on actual owner snapshot %s", async reason => {
  const f = fixture(); f.service.observeSession(42, ownerView("first") as never);
  const mounted = await f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" });
  f.service.observeSession(42, { ...ownerView(reason === "generation" ? "next" : "first", reason !== "source"),
    ...(reason === "reconnecting" ? { syncStatus: "reconnecting" } : {}) } as never);
  expect(f.documents.owns(mounted.mountId, 42)).toBe(false);
  await expect(f.service.invokeAction(42, { mountId: mounted.mountId, input: { requestId, expectedRevision: 1, actionId: "apply", args: {} } }))
    .rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  expect(f.submissions).toEqual([]);
});
it("rejects an in-flight document after a backend generation change even if SSE is late", async () => {
  const f = fixture(); f.changeGeneration();
  await expect(f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" }))
    .rejects.toMatchObject({ code: "plugin_ui_snapshot_changed" });
});

it("refuses legacy capability, extra loader fields, foreign windows and wrong sessions", async () => {
  const f = fixture(); f.withoutLifecycle();
  expect(await f.service.capabilities(42)).toEqual({ available: false });
  await expect(f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" }))
    .rejects.toMatchObject({ code: "plugin_ui_unavailable" });
  const valid = fixture();
  await expect(valid.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result", html: "evil" }))
    .rejects.toMatchObject({ code: "plugin_ui_invalid_message" });
  await expect(valid.service.mount(43, { sessionId: "session", instanceId, surface: "tool-result" }))
    .rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  await expect(valid.service.getState(42, { sessionId: "other", instanceId }))
    .rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  expect(valid.submissions).toEqual([]);
});

it.each(["connection", "session", "window"])("does not register a late document after %s invalidation", async mode => {
  const f = fixture(); f.holdDocument();
  const pending = f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" });
  const rejection = expect(pending).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  await f.documentEntered;
  if (mode === "connection") f.service.invalidateConnection();
  else if (mode === "session") f.setSession("other");
  else f.owner.emit("destroyed");
  f.releaseDocument();
  await rejection;
  expect(f.submissions).toEqual([]);
});

it("allows host dismissal without creating or executing a document", async () => {
  const f = fixture();
  const dismissed = await f.service.dismiss(42, { sessionId: "session", instanceId,
    input: { requestId, expectedRevision: 1 } });
  expect(dismissed.status).toBe("dismissed");
  expect(f.submissions).toEqual(["dismiss"]);
});

it("rejects a document whose component changes while it is fetched", async () => {
  const f = fixture(); f.driftDocument();
  await expect(f.service.mount(42, { sessionId: "session", instanceId, surface: "tool-result" }))
    .rejects.toMatchObject({ code: "plugin_ui_snapshot_changed" });
});

it("refuses an owner main frame that has left the trusted app document", async () => {
  const f = fixture(); f.navigateOwner();
  expect(await f.service.capabilities(42)).toEqual({ available: false });
  await expect(f.service.getState(42, { sessionId: "session", instanceId }))
    .rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
});
