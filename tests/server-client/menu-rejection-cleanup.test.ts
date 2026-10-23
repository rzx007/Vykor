import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { VykorClient } from "@rzx/client";
import { SessionPluginAppService } from "../../packages/server/src/application/session/plugins/session-plugin-app-service.js";
import { DesktopPluginAppService } from "../../apps/desktop/src/main/features/plugin-apps/plugin-app-service.js";
import { PluginAppDocumentStore } from "../../apps/desktop/src/main/features/plugin-apps/document-store.js";
import { PluginAppPageManager } from "../../apps/desktop/src/renderer/src/components/desktop/shell/plugin-apps/page-manager.js";
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "menu-cleanup-"));
  const store = new SessionStore({ path: join(root, "store.db") });
  store.sessions.create({ id: "s", cwd: root, model: "unused" });
  const server = new SessionPluginAppService({ store,
    catalogue: { list: async () => [{ pluginId: "static", pluginVersion: "1", pluginDigest: "p", definitionDigest: "d", backendId: "native", backendKind: "native-tools",
      surfaces: ["a", "b", "c", "d", "valid"].map(id => ({ id, title: id, backend: "native", resourceUri: `ui://static/${id}`, availability: "session" })) }] },
    leaseAuthority: { issue: (_app, backendGeneration) => ({ token: "lease", backendGeneration }), validate: () => true, revoke: () => {}, clear: () => {} },
    resolveCurrent: async () => ({ enabled: true, renderApproved: true, invokeApproved: false, snapshot: "valid", resourceAvailable: true, toolsAvailable: false, backendGeneration: "g", isCurrent: () => true }),
    readExecutionState: () => "unknown",
  });
  let beforeClose: (() => void | Promise<void>) | undefined, beforeRead: (() => void | Promise<void>) | undefined;
  const closes: unknown[] = [];
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    let result: unknown;
    try {
      if (path === "/capabilities") result = { serverVersion: "fixture", protocol: { version: 5 }, features: { pluginApps: 1 } };
      else if (path.endsWith("/open")) result = await server.open("s", body);
      else {
        const source = { sessionId: "s", appId: path.split("/")[4]! };
        if (path.endsWith("/prepare")) result = await server.prepare(source);
        else if (path.endsWith("/close")) { closes.push(body); await beforeClose?.(); result = { app: server.close(source, body) }; }
        else if (path.endsWith("/resources/read")) { await beforeRead?.(); result = { contents: [{ uri: body.uri, mimeType: "text/html;profile=mcp-app", text: "<input>" }] }; }
        else throw new Error("unexpected endpoint: " + path);
      }
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    } catch (error) { return new Response(JSON.stringify({ error: String(error) }), { status: 409, headers: { "content-type": "application/json" } }); }
  } });
  const token = {}, main = new DesktopPluginAppService({ documents: new PluginAppDocumentStore(), getClient: async () => client, getOwnerSessionToken: () => token });
  for (const id of [42, 43]) main.registerOwner(Object.assign(new EventEmitter(), { id, isDestroyed: () => false, getURL: () => "file:///trusted.html" }) as never, "file:///trusted.html");
  cleanups.push(() => { main.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const api = { open: (input: unknown) => main.open(42, input), rejectMenuOpen: (input: unknown) => main.rejectMenuOpen(42, input),
    release: (input: unknown) => main.release(42, input), close: (input: unknown) => main.close(42, input), refresh: (input: unknown) => main.refresh(42, input) };
  const manager = new PluginAppPageManager(api as never, async () => false);
  return { main, server, manager, store, closes, beforeClose: (callback: typeof beforeClose) => { beforeClose = callback; }, beforeRead: (callback: typeof beforeRead) => { beforeRead = callback; },
    count: () => store.pluginApps.list("s").filter(app => app.status === "open").length };
}
async function waitForPage(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100 && !f.manager.snapshot().length; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.manager.snapshot()).toHaveLength(1); return f.manager.snapshot()[0]!;
}
it("four distinct missing-mode rejections release actual durable quota, including repeat opens, before a valid surface", async () => {
  const f = fixture();
  for (const surfaceId of ["a", "b", "c", "d", "a"]) {
    const opening = f.manager.open("s", "static", surfaceId, surfaceId);
    const rejected = expect(opening).rejects.toThrow("没有可用的显示模式");
    const page = await waitForPage(f); expect(f.count()).toBe(1);
    page.onModes!([]); await rejected;
    expect(f.count()).toBe(0); expect(f.manager.snapshot()).toEqual([]);
    expect(f.store.pluginApps.get(page.controller.state.app.id)?.status).toBe("closed");
  }
  const opening = f.manager.open("s", "static", "valid", "Valid");
  (await waitForPage(f)).onModes!(["inline", "fullscreen"]);
  await opening; expect(f.count()).toBe(1); expect(f.store.runs.listRuns("s")).toEqual([]);
});
it("does not close an existing durable app merely because this renderer had no page", async () => {
  const f = fixture(), existing = await f.server.open("s", { pluginId: "static", surfaceId: "a" });
  const opening = f.manager.open("s", "static", "a", "A"), rejected = expect(opening).rejects.toThrow("没有可用的显示模式");
  const page = await waitForPage(f); page.onModes!([]); await rejected;
  expect(f.closes).toEqual([]); expect(f.count()).toBe(1); expect(page.menuRejection).toBeTruthy();
  expect(f.store.pluginApps.get(existing.app.id)?.controlRevision).toBe(0);
});
it("preserves window 2's same-source viewer acquired before window 1 rejects", async () => {
  const f = fixture(), opening = f.manager.open("s", "static", "a", "A"), rejected = expect(opening).rejects.toThrow("没有可用的显示模式");
  const page = await waitForPage(f), other = await f.main.mount(43, page.controller.state.source);
  page.onModes!([]); await rejected;
  expect(f.closes).toEqual([]); expect(f.count()).toBe(1);
  expect(f.main.getBinding(43, other.mountId, false).admitted).toBe(true);
  expect(f.main.getBinding(42, page.id, false).admitted).toBe(true);
  expect(page.menuRejection).toBeTruthy();
});
it("serializes a second viewer still reading its document ahead of cleanup", async () => {
  const f = fixture(), first = await f.main.open(42, { sessionId: "s", pluginId: "static", surfaceId: "a" });
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  f.beforeRead(() => { entered(); return new Promise<void>(resolve => { resume = resolve; }); });
  const mounting = f.main.mount(43, first.state.source); await reading;
  const cleanup = f.main.rejectMenuOpen(42, { mountId: first.mountId });
  await Promise.resolve(); expect(f.closes).toEqual([]);
  resume(); const second = await mounting;
  expect(await cleanup).toEqual({ closed: false }); expect(f.count()).toBe(1);
  expect(f.main.getBinding(43, second.mountId, false).admitted).toBe(true);
});
it.each(["live", "unknown"])("a racing %s operation prevents fixed-revision cleanup without cancellation or substitution", async mode => {
  const f = fixture(), first = await f.main.open(42, { sessionId: "s", pluginId: "static", surfaceId: "a" });
  f.beforeClose(() => {
    f.store.transaction(() => { f.store.runs.createRun({ id: "racing", sessionId: "s" }); f.store.pluginApps.admitAction(first.state.app.id, { expectedRevision: 0, runId: "racing" }); });
    if (mode === "unknown") f.store.pluginApps.settleAction(first.state.app.id, "racing");
  });
  expect(await f.main.rejectMenuOpen(42, { mountId: first.mountId })).toEqual({ closed: false });
  expect(f.closes).toEqual([{ expectedRevision: 0 }]);
  expect(f.count()).toBe(1); expect(f.store.runs.getRun("racing")).toBeTruthy();
  expect(f.store.pluginApps.get(first.state.app.id)).toMatchObject(mode === "live" ? { status: "open", activeActionRunId: "racing", controlRevision: 1 } : { status: "open", lastActionRunId: "racing", controlRevision: 2 });
  expect(f.main.getBinding(42, first.mountId, false).admitted).toBe(true);
});

it("an independent same-window acquisition consumes the menu-only cleanup proof", async () => {
  const f = fixture(), first = await f.main.open(42, { sessionId: "s", pluginId: "static", surfaceId: "a" });
  const acquired = await f.main.mount(42, first.state.source);
  expect(acquired.mountId).toBe(first.mountId);
  expect(await f.main.rejectMenuOpen(42, { mountId: first.mountId })).toEqual({ closed: false });
  expect(f.closes).toEqual([]); expect(f.count()).toBe(1);
});
