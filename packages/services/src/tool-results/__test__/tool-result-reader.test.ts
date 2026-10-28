import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../session-runtime/store.js";
import { ToolResultReader } from "../index.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture(storage: "memory" | "sqlite" = "sqlite", transactionHooks: import("../../database/transactions/transaction-coordinator.js").TransactionCoordinatorHooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tool-result-read-")), path = join(directory, "state.db");
  const store = new SessionStore({ path, transactionHooks });
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  store.sessions.create({ id: "s", cwd: directory, model: "m", storage });
  store.runs.createRun({ id: "r", sessionId: "s" });
  return { directory, path, store, reader: new ToolResultReader(store.toolResults) };
}
const source = { kind: "plugin", id: "selected" };
function result(text: string) { return { toolUseId: "call", toolName: "Read", content: [{ type: "text" as const, text }], executionState: "completed" as const }; }
describe("independent tool result storage", () => {
  it("saves complete returned text without a dispatch record and reopens its new reference", () => {
    const f = fixture(), value = { ...result("x".repeat(300_000) + "TAIL-EVIDENCE"), isError: true, resultRef: { id: "forged", toolName: "Other", totalChars: 9 } };
    const ref = f.reader.retain("s", "r", value, source);
    expect(ref.id).toMatch(/^result:[0-9a-f-]{36}$/);
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    const reader = new ToolResultReader(reopened.toolResults);
    expect(reader.list("s").items).toEqual([ref]);
    expect(reader.read("s", { id: ref.id, offset: 300_000 }).text).toBe("TAIL-EVIDENCE");
    expect(reader.search("s", { id: ref.id, query: "TAIL-EVIDENCE" }).matches).toEqual([{ offset: 300_000, text: "TAIL-EVIDENCE" }]);
    expect(() => reader.read("other", { id: ref.id })).toThrow();
    expect(() => reader.read("s", { id: ref.id }, () => false)).toThrow();
    expect(reader.list("s", {}, () => false)).toEqual({ items: [] });
    expect(() => reader.read("s", { id: "result:operation_00000000-0000-0000-0000-000000000000:none" })).toThrow();
  });
  it.each(["unknown", "not_started", undefined] as const)("rejects incomplete feedback %s", executionState => {
    const f = fixture();
    expect(() => f.reader.retain("s", "r", { ...result("partial"), executionState }, source)).toThrow();
    expect(f.reader.list("s").items).toEqual([]);
  });
  it("rolls back result body when the containing transaction fails", () => {
    const f = fixture();
    expect(() => f.store.transaction(() => { f.reader.retain("s", "r", result("returned"), source); throw new Error("rollback"); })).toThrow("rollback");
    expect(f.reader.list("s").items).toEqual([]);
  });
  it("discards memory session results on close", () => {
    const f = fixture("memory"), ref = f.reader.retain("s", "r", result("temporary"), source);
    expect(f.reader.read("s", { id: ref.id }).text).toBe("temporary");
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    expect(new ToolResultReader(reopened.toolResults).list("s").items).toEqual([]);
  });
  it.each(["beforeFlush", "afterMutationSql", "beforeCommit"] as const)("rolls back a result when SQLite %s fails, and later accepts a new result", hook => {
    let fail = false;
    const f = fixture("sqlite", { [hook]: () => { if (fail) throw new Error("injected storage failure"); } });
    fail = true;
    expect(() => f.reader.retain("s", "r", result("unsaved"), source)).toThrow("injected storage failure");
    expect(f.reader.list("s").items).toEqual([]);
    fail = false;
    const ref = f.reader.retain("s", "r", result("new result"), source);
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    const reader = new ToolResultReader(reopened.toolResults);
    expect(reader.list("s").items).toEqual([ref]);
    expect(reader.read("s", { id: ref.id }).text).toBe("new result");
  });
  it.each(["memory", "sqlite"] as const)("removes %s result bodies with their session", storage => {
    const f = fixture(storage), ref = f.reader.retain("s", "r", result("delete with session"), source);
    f.store.conversationTransactions.deleteSessionTree("s");
    expect(f.reader.list("s").items).toEqual([]);
    expect(() => f.reader.read("s", { id: ref.id })).toThrow();
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    expect(reopened.toolResults.get(ref.id.slice(7))).toBeUndefined();
  });

});
