import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../session-runtime/store.js";
import type { CreatePluginAppInput } from "../repository.js";

const directories: string[] = [];
const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup(storage: "sqlite" | "memory" = "sqlite", transactionHooks?: { afterMutationSql?: () => void }) {
  const directory = mkdtempSync(join(tmpdir(), "plugin-apps-")); directories.push(directory);
  const path = join(directory, "sessions.db");
  const store = new SessionStore({ path, transactionHooks }); stores.push(store);
  store.sessions.create({ id: "s", cwd: directory, model: "m", storage });
  const input: CreatePluginAppInput = {
    sessionId: "s", pluginId: "notes", pluginVersion: "1", pluginDigest: "p", definitionDigest: "d",
    backendId: "native", backendKind: "native-tools", resourceUri: "ui://notes", origin: { kind: "surface", surfaceId: "notes" }, logicalKey: "surface:notes:d",
  };
  return { store, input, path };
}

describe("plugin app repository", () => {
  it("uses one logical identity and creates no transcript or Run", () => {
    const { store, input } = setup();
    const first = store.pluginApps.create(input);
    expect(store.pluginApps.create(input)).toEqual(first);
    expect(first.controlRevision).toBe(0);
    expect(store.conversations.listMessages("s")).toEqual([]);
    expect(store.runs.listRuns("s")).toEqual([]);
    expect(store.pluginApps.create({ ...input, backendKind: "mcp-server", logicalKey: "mcp" }).backendKind).toBe("mcp-server");
  });

  it("increments current revision once per real transition and preserves unknown pointers", () => {
    const { store, input } = setup();
    const app = store.pluginApps.create(input);
    store.runs.createRun({ id: "r", sessionId: "s" });
    expect(store.pluginApps.admitAction(app.id, { expectedRevision: 0, runId: "r" }).controlRevision).toBe(1);
    expect(() => store.pluginApps.admitAction(app.id, { expectedRevision: 0, runId: "other" })).toThrow();
    expect(store.pluginApps.close(app.id).controlRevision).toBe(2);
    expect(store.pluginApps.close(app.id).controlRevision).toBe(2);
    expect(store.pluginApps.settleAction(app.id, "r")).toMatchObject({ controlRevision: 3, status: "closed", lastActionRunId: "r" });
    expect(store.pluginApps.get(app.id)?.activeActionRunId).toBeUndefined();
    expect(store.pluginApps.settleAction(app.id, "r").controlRevision).toBe(3);
    expect(store.pluginApps.reopen(app.id)).toMatchObject({ controlRevision: 4, lastActionRunId: "r" });
    expect(store.pluginApps.revoke(app.id).controlRevision).toBe(5);
    expect(store.pluginApps.revoke(app.id).controlRevision).toBe(5);
    expect(() => store.pluginApps.reopen(app.id)).toThrow();
  });

  it.each(["sqlite", "memory"] as const)("rolls back creation, updates and memory persistence for %s", (storage) => {
    const { store, input } = setup(storage);
    expect(() => store.transaction(() => { store.pluginApps.create(input); throw new Error("rollback"); })).toThrow();
    expect(store.pluginApps.list("s")).toEqual([]);
    const app = store.pluginApps.create(input);
    expect(() => store.transaction(() => { store.pluginApps.close(app.id); throw new Error("rollback"); })).toThrow();
    expect(store.pluginApps.get(app.id)).toEqual(app);
  });

  it("reads durable facts after restart and enforces SQL uniqueness", () => {
    const { store, input, path } = setup();
    const app = store.pluginApps.create(input);
    store.runs.createRun({ id: "r", sessionId: "s" });
    store.pluginApps.admitAction(app.id, { expectedRevision: 0, runId: "r" });
    store.pluginApps.close(app.id); store.pluginApps.settleAction(app.id, "r"); store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new SessionStore({ path }); stores.push(reopened);
    expect(reopened.pluginApps.get(app.id)).toMatchObject({ status: "closed", lastActionRunId: "r", controlRevision: 3 });
    const database = new Database(path);
    try {
      expect(() => database.exec("INSERT INTO session_plugin_app SELECT 'duplicate', session_id, plugin_id, plugin_version, plugin_digest, definition_digest, backend_id, backend_kind, resource_uri, origin_json, logical_key, status, control_revision, active_action_run_id, last_action_run_id, created_at, updated_at FROM session_plugin_app")).toThrow();
    } finally { database.close(); }
  });

  it("never saves temporary app records to SQLite or restores them on restart", () => {
    const { store, input, path } = setup("memory");
    store.pluginApps.create(input);
    const database = new Database(path);
    try { expect(database.prepare("SELECT COUNT(*) AS n FROM session_plugin_app").get()).toEqual({ n: 0 }); } finally { database.close(); }
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new SessionStore({ path }); stores.push(reopened);
    expect(reopened.pluginApps.list("s")).toEqual([]);
  });

  it.each(["sqlite", "memory"] as const)("restores live cache and persistence after a late %s commit failure", (storage) => {
    let fail = false;
    const { store, input, path } = setup(storage, { afterMutationSql: () => { if (fail) throw new Error("late failure"); } });
    fail = true;
    expect(() => store.pluginApps.create(input)).toThrow("late failure");
    expect(store.pluginApps.list("s")).toEqual([]);
    fail = false;
    const app = store.pluginApps.create(input);
    fail = true;
    expect(() => store.pluginApps.close(app.id)).toThrow("late failure");
    expect(store.pluginApps.get(app.id)).toEqual(app);
    fail = false;
    const database = new Database(path);
    try {
      expect(database.prepare("SELECT status, control_revision FROM session_plugin_app").all()).toEqual(storage === "sqlite" ? [{ status: "open", control_revision: 0 }] : []);
    } finally { database.close(); }
  });

  it.each(["sqlite", "memory"] as const)("deletes app state with the %s session and rolls back rejected deletion", (storage) => {
    const { store, input, path } = setup(storage);
    const app = store.pluginApps.create(input);
    store.conversationTransactions.setTestHooks({ afterDeleteMemory: () => { throw new Error("delete failed"); } });
    expect(() => store.conversationTransactions.deleteSessionTree("s")).toThrow("delete failed");
    expect(store.pluginApps.get(app.id)).toEqual(app);
    store.conversationTransactions.setTestHooks(undefined);
    store.conversationTransactions.deleteSessionTree("s");
    expect(store.pluginApps.get(app.id)).toBeUndefined();
    const database = new Database(path);
    try { expect(database.prepare("SELECT COUNT(*) AS n FROM session_plugin_app").get()).toEqual({ n: 0 }); } finally { database.close(); }
  });

  it("preserves legacy UI history without importing its identity or result", () => {
    const { store, input } = setup();
    store.conversations.createMessage({ id: "m", sessionId: "s", role: "assistant" });
    const old = store.conversations.upsertMessagePart({ id: "old-ui", sessionId: "s", messageId: "m", type: "tool", status: "completed",
      output: { oldResult: "private" }, metadata: { uiInstance: { instanceId: "legacy", sourceRunId: "old-run", revision: 9 } } });
    expect(store.pluginApps.list("s")).toEqual([]);
    store.pluginApps.create(input);
    expect(store.conversations.listMessageParts("s")).toEqual([old]);
    expect(store.pluginApps.list("s")[0]).not.toHaveProperty("output");
  });

  it("settles a revoked app at its current revision and never revives it", () => {
    const { store, input } = setup();
    const app = store.pluginApps.create(input);
    store.transaction(() => { store.runs.createRun({ id: "r", sessionId: "s" }); store.pluginApps.admitAction(app.id, { expectedRevision: 0, runId: "r" }); });
    store.pluginApps.revoke(app.id);
    expect(store.pluginApps.settleAction(app.id, "r")).toMatchObject({ status: "revoked", controlRevision: 3, lastActionRunId: "r" });
    expect(store.pluginApps.settleAction(app.id, "r").controlRevision).toBe(3);
  });
});
