import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../session-runtime/store.js";
import { IncrementalOutput } from "./incremental-output.js";

afterEach(() => vi.useRealTimers());

function setup(bytes = 1024) {
  const dir = mkdtempSync(join(tmpdir(), "vk-incremental-"));
  const path = join(dir, "store.db");
  const store = new SessionStore({ path, deltaFlushBytes: bytes, deltaFlushIntervalMs: 60_000 });
  store.sessions.create({ id: "s", cwd: dir, model: "m" });
  const message = store.conversations.createMessage({ id: "m", sessionId: "s", role: "assistant" });
  store.conversations.upsertMessagePart({ id: "p", sessionId: "s", messageId: message.id, type: "text", status: "running", text: "" });
  return { dir, path, store };
}

describe("IncrementalOutput", () => {
  it("flushes a low-threshold delta before database backup", async () => {
    const { dir, store } = setup();
    const backupPath = join(dir, "backup.db");
    try {
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "backup tail" });
      const expected = {
        part: store.conversations.listMessageParts("s")[0]!,
        message: store.conversations.listMessages("s")[0]!,
        session: store.sessions.get("s")!,
      };
      await store.backupDatabase(backupPath);
      const backup = new SessionStore({ path: backupPath });
      try {
        expect(backup.conversations.listMessageParts("s")[0]).toMatchObject({ text: "backup tail", updatedAt: expected.part.updatedAt });
        expect(backup.conversations.listMessages("s")[0]!.updatedAt).toBe(expected.message.updatedAt);
        expect(backup.sessions.get("s")!.updatedAt).toBe(expected.session.updatedAt);
      } finally { backup.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["completed", "failed", "interrupted"] as const)("persists the final delta through a %s run transition", (status) => {
    const { dir, path, store } = setup();
    store.runs.createRun({ id: "run", sessionId: "s" });
    store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: `${status} tail` });
    store.runs.updateRun("run", { status });
    const storage = (store as any).storage;
    const part = store.conversations.listMessageParts("s")[0]!;
    const message = store.conversations.listMessages("s")[0]!;
    const session = store.sessions.get("s")!;
    expect(storage.database.connection.prepare("SELECT text, updated_at FROM session_message_part WHERE id='p'").get()).toEqual({ text: `${status} tail`, updated_at: part.updatedAt });
    expect(storage.database.connection.prepare("SELECT updated_at FROM session_message WHERE id='m'").get()).toEqual({ updated_at: message.updatedAt });
    expect(storage.database.connection.prepare("SELECT updated_at FROM session WHERE id='s'").get()).toEqual({ updated_at: session.updatedAt });
    store.close();
    const reopened = new SessionStore({ path });
    try {
      expect(reopened.conversations.listMessageParts("s")[0]).toMatchObject({ text: `${status} tail`, updatedAt: part.updatedAt });
      expect(reopened.conversations.listMessages("s")[0]!.updatedAt).toBe(message.updatedAt);
      expect(reopened.sessions.get("s")!.updatedAt).toBe(session.updatedAt);
    }
    finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("flushes dirty output before interruptActiveRuns returns", () => {
    const { dir, path, store } = setup();
    const run = store.runs.createRun({ id: "run", sessionId: "s" });
    store.runs.updateRun(run.id, { status: "running" });
    const attempt = store.runs.createRunAttempt({ id: "attempt", runId: run.id });
    store.runs.updateRunAttempt(attempt.id, { status: "running" });
    const message = store.conversations.createMessage({ id: "run-message", sessionId: "s", role: "assistant", runId: run.id });
    store.conversations.upsertMessagePart({ id: "run-part", sessionId: "s", messageId: message.id, type: "text", status: "running", text: "" });
    store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: message.id, partId: "run-part", field: "text", delta: "interrupt tail" });

    expect(store.interruptActiveRuns()).toBe(1);
    const storage = (store as any).storage;
    const part = store.conversations.listMessageParts("s").find(({ id }) => id === "run-part")!;
    const persistedMessage = store.conversations.listMessages("s").find(({ id }) => id === "run-message")!;
    const session = store.sessions.get("s")!;
    expect(storage.database.connection.prepare("SELECT text, status, updated_at FROM session_message_part WHERE id='run-part'").get()).toEqual({ text: "interrupt tail", status: "interrupted", updated_at: part.updatedAt });
    expect(storage.database.connection.prepare("SELECT updated_at FROM session_message WHERE id='run-message'").get()).toEqual({ updated_at: persistedMessage.updatedAt });
    expect(storage.database.connection.prepare("SELECT updated_at FROM session WHERE id='s'").get()).toEqual({ updated_at: session.updatedAt });
    expect(store.runs.getRun("run")!.status).toBe("interrupted");
    expect(store.runs.getRunAttempt("attempt")!.status).toBe("cancelled");
    expect(part.status).toBe("interrupted");

    store.close();
    const reopened = new SessionStore({ path });
    try {
      expect(reopened.runs.getRun("run")!.status).toBe("interrupted");
      expect(reopened.runs.getRunAttempt("attempt")!.status).toBe("cancelled");
      expect(reopened.conversations.listMessageParts("s").find(({ id }) => id === "run-part")).toMatchObject({ text: "interrupt tail", status: "interrupted", updatedAt: part.updatedAt });
      expect(reopened.conversations.listMessages("s").find(({ id }) => id === "run-message")!.updatedAt).toBe(persistedMessage.updatedAt);
      expect(reopened.sessions.get("s")!.updatedAt).toBe(session.updatedAt);
    } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops old dirty output when replacing the transcript and persists only new history", () => {
    const { dir, path, store } = setup();
    store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "old dirty tail" });
    store.conversationTransactions.replaceTranscript({ sessionId: "s", messages: [{ role: "assistant", parts: [{ type: "text", text: "new summary" }] }] });
    expect((store as any).storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
    store.close();
    const reopened = new SessionStore({ path });
    try {
      expect(reopened.conversations.listMessages("s")).toHaveLength(1);
      expect(reopened.conversations.listMessageParts("s").map(({ text }) => text)).toEqual(["new summary"]);
    } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("flushes on the interval timer", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "vk-incremental-timer-"));
    const store = new SessionStore({ path: join(dir, "store.db"), deltaFlushBytes: 1024, deltaFlushIntervalMs: 10 });
    try {
      store.sessions.create({ id: "s", cwd: dir, model: "m" });
      const message = store.conversations.createMessage({ id: "m", sessionId: "s", role: "assistant" });
      store.conversations.upsertMessagePart({ id: "p", sessionId: "s", messageId: message.id, type: "text", text: "" });
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "timer" });
      const db = (store as any).storage.database.connection;
      expect(db.prepare("SELECT text FROM session_message_part WHERE id='p'").pluck().get()).toBe("");
      await vi.advanceTimersByTimeAsync(10);
      expect(db.prepare("SELECT text FROM session_message_part WHERE id='p'").pluck().get()).toBe("timer");
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("validates ownership, preserves accepted type/status, and allocates a cloned transient event before text", () => {
    const { dir, store } = setup();
    try {
      const storage = (store as any).storage;
      let textWhenEventAllocated: string | undefined;
      const output = new IncrementalOutput({
        storage,
        appendTransientEvent: (input) => {
          textWhenEventAllocated = storage.state.parts.p.text;
          return store.conversations.appendEventInMemory(input, false);
        },
      });
      const beforeSeq = store.conversations.latestEventSeq();
      const event = output.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "x" });
      expect(textWhenEventAllocated).toBe("");
      expect(event).toMatchObject({ seq: beforeSeq + 1, type: "session.message.part.delta", payload: { sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "x" } });
      expect(store.conversations.listEvents().some(({ id }) => id === event.id)).toBe(false);
      event.payload.delta = "changed";
      expect(store.conversations.listMessageParts("s")[0]!.text).toBe("x");
      store.conversations.upsertMessagePart({ id: "p", sessionId: "s", messageId: "m", type: "tool", status: "failed" });
      expect(() => output.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "y" })).not.toThrow();
      expect(() => output.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "missing", field: "text", delta: "z" })).toThrow("Session message part not found: missing");
      expect(() => output.appendMessagePartDelta({ sessionId: "missing", messageId: "m", partId: "p", field: "text", delta: "z" })).toThrow("Session not found: missing");
      store.sessions.create({ id: "other", cwd: dir, model: "m" });
      expect(() => output.appendMessagePartDelta({ sessionId: "other", messageId: "m", partId: "p", field: "text", delta: "z" })).toThrow(/does not belong/);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps memory ahead of SQLite, counts UTF-8 bytes, and flushes at threshold", () => {
    const { dir, store } = setup(6);
    try {
      const db = (store as any).storage.database.connection;
      const text = () => (db.prepare("SELECT text FROM session_message_part WHERE id = 'p'").get() as { text: string }).text;
      const event = store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "你" });
      expect(event.type).toBe("session.message.part.delta");
      expect(store.conversations.listMessageParts("s")[0]!.text).toBe("你");
      expect(text()).toBe("");
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "好" });
      expect(text()).toBe("你好");
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains dirty state after SQL failure and succeeds on retry", () => {
    const { dir, path, store } = setup();
    try {
      const storage = (store as any).storage;
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "tail" });
      storage.database.connection.exec("CREATE TRIGGER fail_delta BEFORE UPDATE ON session_message BEGIN SELECT RAISE(ABORT, 'delta failure'); END;");
      expect(() => store.incrementalOutput.flushMessagePartDeltas()).toThrow("delta failure");
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["p"]);
      expect(storage.database.connection.prepare("SELECT text FROM session_message_part WHERE id='p'").pluck().get()).toBe("");
      storage.database.connection.exec("DROP TRIGGER fail_delta");
      store.incrementalOutput.flushMessagePartDeltas();
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
      const part = store.conversations.listMessageParts("s")[0]!;
      const message = store.conversations.listMessages("s")[0]!;
      const session = store.sessions.get("s")!;
      expect(storage.database.connection.prepare("SELECT text, updated_at FROM session_message_part WHERE id='p'").get()).toEqual({ text: "tail", updated_at: part.updatedAt });
      expect(storage.database.connection.prepare("SELECT updated_at FROM session_message WHERE id='m'").get()).toEqual({ updated_at: message.updatedAt });
      expect(storage.database.connection.prepare("SELECT updated_at FROM session WHERE id='s'").get()).toEqual({ updated_at: session.updatedAt });
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.conversations.listMessageParts("s")[0]).toMatchObject({ text: "tail", updatedAt: part.updatedAt });
        expect(reopened.conversations.listMessages("s")[0]!.updatedAt).toBe(message.updatedAt);
        expect(reopened.sessions.get("s")!.updatedAt).toBe(session.updatedAt);
      } finally { reopened.close(); }
    } finally {
      try { store.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores text, timestamps, and checkpoint on atomic rollback and flushes on close", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { dir, path, store } = setup();
    const before = { part: store.conversations.listMessageParts("s")[0]!, message: store.conversations.listMessages("s")[0]!, session: store.sessions.get("s")! };
    expect(() => store.transaction(() => {
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "rolled back" });
      expect(store.conversations.listMessageParts("s")[0]).toMatchObject({ text: "rolled back", updatedAt: before.part.updatedAt + 10_000 });
      expect(store.conversations.listMessages("s")[0]!.updatedAt).toBe(before.message.updatedAt + 10_000);
      expect(store.sessions.get("s")!.updatedAt).toBe(before.session.updatedAt + 10_000);
      expect((store as any).storage.deltaCheckpoint.dirtyPartIds()).toEqual(["p"]);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.conversations.listMessageParts("s")[0]).toEqual(before.part);
    expect(store.conversations.listMessages("s")[0]).toEqual(before.message);
    expect(store.sessions.get("s")).toEqual(before.session);
    expect((store as any).storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
    store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "closed" });
    store.close();
    const reopened = new SessionStore({ path });
    try { expect(reopened.conversations.listMessageParts("s")[0]!.text).toBe("closed"); }
    finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("closes checkpoint and database while preserving the original flush error", async () => {
    vi.useFakeTimers();
    const { dir, store } = setup();
    const storage = (store as any).storage;
    store.incrementalOutput.appendMessagePartDelta({ sessionId: "s", messageId: "m", partId: "p", field: "text", delta: "tail" });
    storage.database.connection.exec("CREATE TRIGGER fail_close_delta BEFORE UPDATE ON session_message BEGIN SELECT RAISE(ABORT, 'close delta failure'); END;");
    expect(() => store.close()).toThrow("close delta failure");
    expect((storage.deltaCheckpoint as any).closed).toBe(true);
    expect(() => storage.database.connection.prepare("SELECT 1")).toThrow();
    await vi.runOnlyPendingTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
