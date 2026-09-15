import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session-runtime/store.js";

function setup(bytes = 1024) {
  const dir = mkdtempSync(join(tmpdir(), "ohs-incremental-"));
  const path = join(dir, "store.db");
  const store = new SessionStore({ path, deltaFlushBytes: bytes, deltaFlushIntervalMs: 60_000 });
  store.createSession({ id: "s", cwd: dir, model: "m" });
  const message = store.createMessage({ id: "m", sessionId: "s", role: "assistant" });
  store.upsertMessagePart({ id: "p", sessionId: "s", messageId: message.id, type: "text", status: "running", text: "" });
  return { dir, path, store };
}

describe("IncrementalOutput", () => {
  it("keeps memory ahead of SQLite, counts UTF-8 bytes, and flushes at threshold", () => {
    const { dir, store } = setup(6);
    try {
      const db = (store as any).storage.database.connection;
      const text = () => (db.prepare("SELECT text FROM session_message_part WHERE id = 'p'").get() as { text: string }).text;
      const event = store.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "你" });
      expect(event.type).toBe("session.message.part.delta");
      expect(store.listMessageParts("s")[0]!.text).toBe("你");
      expect(text()).toBe("");
      store.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "好" });
      expect(text()).toBe("你好");
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains dirty state after SQL failure and succeeds on retry", () => {
    const { dir, store } = setup();
    try {
      const storage = (store as any).storage;
      store.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "tail" });
      storage.database.connection.exec("CREATE TRIGGER fail_delta BEFORE UPDATE OF text ON session_message_part BEGIN SELECT RAISE(ABORT, 'delta failure'); END;");
      expect(() => store.flushMessagePartDeltas()).toThrow("delta failure");
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["p"]);
      storage.database.connection.exec("DROP TRIGGER fail_delta");
      store.flushMessagePartDeltas();
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("restores text, timestamps, and checkpoint on atomic rollback and flushes on close", () => {
    const { dir, path, store } = setup();
    const before = store.listMessageParts("s")[0]!;
    expect(() => store.transaction(() => {
      store.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "rolled back" });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.listMessageParts("s")[0]).toEqual(before);
    expect((store as any).storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
    store.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "closed" });
    store.close();
    const reopened = new SessionStore({ path });
    try { expect(reopened.listMessageParts("s")[0]!.text).toBe("closed"); }
    finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
