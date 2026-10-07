import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./store.js";
import type { StorageContext } from "../database/storage-context.js";
import { TransactionJournal } from "../database/transaction-journal.js";

describe("temporary chat storage", () => {
  it("restores rejected temporary deltas in both live records and memory using only the journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-journal-delta-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "temporary", cwd: directory, model: "m", storage: "memory" });
      store.conversations.createMessage({ id: "message", sessionId: "temporary", role: "assistant" });
      store.conversations.upsertMessagePart({ id: "part", sessionId: "temporary", messageId: "message", type: "text", text: "" });
      const delta = { sessionId: "temporary", messageId: "message", partId: "part", field: "text" as const };
      store.incrementalOutput.appendMessagePartDelta({ ...delta, delta: "accepted" });
      const storage = (store as unknown as { storage: StorageContext }).storage;
      const acceptedPart = structuredClone(storage.state.parts.part);
      const acceptedMessage = structuredClone(storage.state.messages.message);
      const acceptedSession = structuredClone(storage.state.sessions.temporary);
      storage.rollback = new TransactionJournal();
      store.incrementalOutput.appendMessagePartDelta({ ...delta, delta: " rejected" });
      expect(storage.chatPersistence!.snapshot().parts.part!.text).toBe("accepted rejected");
      storage.rollback.rollback();
      storage.rollback = undefined;
      expect(storage.state.parts.part).toEqual(acceptedPart);
      expect(storage.state.messages.message).toEqual(acceptedMessage);
      expect(storage.state.sessions.temporary).toEqual(acceptedSession);
      expect(storage.chatPersistence!.snapshot().parts.part).toEqual(acceptedPart);
      expect(storage.chatPersistence!.snapshot().messages.message).toEqual(acceptedMessage);
      expect(storage.chatPersistence!.snapshot().sessions.temporary).toEqual(acceptedSession);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("routes deleted sessions from journal history and gives a current record precedence", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-journal-routing-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const formal = store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      const storage = (store as unknown as { storage: StorageContext }).storage;
      storage.state.sessions.unpersisted = { ...formal, id: "unpersisted", storage: "memory" };
      storage.rollback = new TransactionJournal();
      storage.rollback.capture(storage.state.sessions, "unpersisted");
      delete storage.state.sessions.unpersisted;
      expect(storage.chatPersistence!.isTemporary("unpersisted")).toBe(true);
      storage.state.sessions.unpersisted = { ...formal, id: "unpersisted", storage: "sqlite" };
      expect(storage.chatPersistence!.isTemporary("unpersisted")).toBe(false);
      storage.rollback.rollback();
      storage.rollback = undefined;
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps retained temporary event IDs unique", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-event-id-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const session = store.sessions.create({ id: "temporary", cwd: directory, model: "m", storage: "memory" });
      const event = { id: "same-event", sessionId: session.id, type: "session.updated", payload: { session } };
      store.conversations.appendEvent(event);
      expect(() => store.conversations.appendEvent(event)).toThrow("already exists");
      expect(store.conversations.listEvents({ sessionId: session.id }).filter((item) => item.id === event.id)).toHaveLength(1);
      expect((store as any).storage.chatPersistence.snapshot().events.filter((item: { id: string }) => item.id === event.id)).toHaveLength(1);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects an asynchronous persistence result before announcing a successful transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-sync-boundary-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "temporary", cwd: directory, model: "m", storage: "memory" });
      const storage = (store as any).storage;
      const original = storage.chatPersistence.memory.commit;
      storage.chatPersistence.memory.commit = () => Promise.resolve();
      let notified = false;
      try {
        expect(() => store.transaction(() => {
          store.conversationTransactions.admitPrompt({ sessionId: "temporary", content: "not committed" });
          storage.deferUntilCommit(() => { notified = true; });
        })).toThrow("asynchronous");
        expect(notified).toBe(false);
        expect(store.conversations.listInputs("temporary")).toEqual([]);
      } finally { storage.chatPersistence.memory.commit = original; }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps temporary checkpoints in JS without rolling formal snapshot cursors back on restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-checkpoint-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path, deltaFlushBytes: 1 });
    try {
      store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      const storage = (store as any).storage;
      const database = storage.database.connection;
      store.sessions.create({ id: "temporary", parentId: "formal", cwd: directory, model: "m", storage: "memory" });
      store.transaction(() => {
        for (let index = 0; index < 1050; index++) store.conversations.createMessage({ id: `temp-${index}`, sessionId: "temporary", role: "assistant" });
      });
      store.conversations.upsertMessagePart({ id: "temporary-part", sessionId: "temporary", messageId: "temp-0", type: "text", text: "" });
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "temporary", messageId: "temp-0", partId: "temporary-part", field: "text", delta: "only memory" });
      expect(storage.chatPersistence.snapshot().parts["temporary-part"].text).toBe("only memory");
      expect(database.prepare("SELECT count(*) AS count FROM session_message_part").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM session_event WHERE session_id = 'temporary'").get()).toEqual({ count: 0 });
      const publishedCursor = store.conversationTransactions.getSessionState("formal").cursor;
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.conversationTransactions.getSessionState("formal").cursor).toBeGreaterThanOrEqual(publishedCursor);
        expect(reopened.sessions.get("temporary")).toBeUndefined();
        reopened.conversations.createMessage({ sessionId: "formal", role: "assistant" });
        expect(reopened.conversations.listEvents({ sessionId: "formal" }).at(-1)?.seq).toBeGreaterThan(publishedCursor);
      } finally { reopened.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves accepted temporary text when an unrelated SQLite save fails before a scheduled checkpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-pending-delta-"));
    const store = new SessionStore({ path: join(directory, "sessions.db"), deltaFlushBytes: 100_000, deltaFlushIntervalMs: 60_000 });
    try {
      store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      store.sessions.create({ id: "temporary", cwd: directory, model: "m", storage: "memory" });
      store.conversations.createMessage({ id: "message", sessionId: "temporary", role: "assistant" });
      store.conversations.upsertMessagePart({ id: "part", sessionId: "temporary", messageId: "message", type: "text", text: "" });
      store.incrementalOutput.appendMessagePartDelta({ sessionId: "temporary", messageId: "message", partId: "part", field: "text", delta: "accepted" });
      expect(store.conversations.listMessageParts("temporary")[0]?.text).toBe("accepted");
      const storage = (store as any).storage;
      storage.coordinator.setHooks({ beforeCommit: () => { throw new Error("commit failed"); } });
      expect(() => store.conversations.createMessage({ sessionId: "formal", role: "assistant" })).toThrow("commit failed");
      expect(store.conversations.listMessageParts("temporary")[0]?.text).toBe("accepted");
      expect(store.conversations.listMessages("formal")).toEqual([]);
      storage.coordinator.setHooks();
      expect(() => store.transaction(() => {
        store.incrementalOutput.appendMessagePartDelta({ sessionId: "temporary", messageId: "message", partId: "part", field: "text", delta: " rejected" });
        throw new Error("rollback delta");
      })).toThrow("rollback delta");
      expect(store.conversations.listMessageParts("temporary")[0]?.text).toBe("accepted");
      expect(storage.chatPersistence.snapshot().parts.part.text).toBe("accepted");
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_message_part").get()).toEqual({ count: 0 });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains attachment attribution when temporary chat records are deleted or rolled back", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-resource-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      store.sessions.create({ id: "temporary", parentId: "formal", cwd: directory, model: "m", storage: "memory" });
      for (const id of ["asset", "rejected"]) {
        store.attachments.createImportingAttachment({ id, displayName: `${id}.txt`, stagingName: `${id}.part` });
        store.attachments.markAttachmentReady(id, { sha256: (id === "asset" ? "a" : "b").repeat(64), sizeBytes: 12, mediaType: "text/plain" });
      }
      const storage = (store as any).storage;
      storage.coordinator.setHooks({ beforeCommit: () => { throw new Error("commit failed"); } });
      expect(() => store.conversationTransactions.admitPrompt({ sessionId: "temporary", content: "reject", attachments: [{ assetId: "rejected", intent: "file" }] }))
        .toThrow("commit failed");
      expect(store.attachments.getAttachment("rejected")?.chatSources).toBeUndefined();
      storage.coordinator.setHooks();
      store.conversationTransactions.admitPrompt({ sessionId: "temporary", content: "keep", attachments: [{ assetId: "asset", intent: "file" }] });
      expect(store.attachments.getAttachment("asset")?.chatSources).toContainEqual({ storage: "memory", sessionId: "temporary" });
      store.conversationTransactions.deleteSessionTree("temporary");
      expect(store.attachments.hasPersistentChatSource("asset")).toBe(true);
      expect(store.attachments.countAttachmentReferences("asset")).toBe(1);
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_input_attachment").get()).toEqual({ count: 0 });
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.attachments.hasPersistentChatSource("asset")).toBe(true);
        expect(reopened.sessions.get("temporary")).toBeUndefined();
      } finally { reopened.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not let a formal message claim a temporary run or input", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-ownership-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      store.sessions.create({ id: "temporary", parentId: "formal", cwd: directory, model: "m", storage: "memory" });
      const admitted = store.conversationTransactions.admitPromptWithRun({ prompt: { sessionId: "temporary", content: "try" }, run: { id: "temp-run" } });
      expect(() => store.conversations.createMessage({ sessionId: "formal", role: "assistant", runId: admitted.run.id }))
        .toThrow("does not belong");
      expect(() => store.conversations.createMessage({ sessionId: "formal", role: "user", inputId: admitted.input.id }))
        .toThrow("does not belong");
      expect(store.conversations.listMessages("formal")).toEqual([]);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("runs both chat lifetimes in one store and only restores SQLite chats", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-mixed-chat-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      const formal = store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      const temporary = store.sessions.create({ id: "temporary", parentId: formal.id, cwd: directory, model: "m", storage: "memory" } as any);
      const admitted = store.conversationTransactions.admitPromptWithRun({ prompt: { sessionId: temporary.id, content: "try this" }, run: { id: "temporary-run" } });
      const message = store.conversations.createMessage({ id: "temporary-message", sessionId: temporary.id, role: "assistant", runId: admitted.run.id });
      store.conversations.upsertMessagePart({ id: "temporary-tool", sessionId: temporary.id, messageId: message.id, type: "tool", status: "completed", toolName: "read_file", output: { content: "result" } });
      store.transaction(() => store.runs.updateRun(admitted.run.id, { status: "completed" }));
      expect(store.conversations.listMessageParts(temporary.id)[0]?.output).toEqual({ content: "result" });
      const database = (store as any).storage.database.connection;
      expect(database.prepare("SELECT id FROM session").all()).toEqual([{ id: "formal" }]);
      for (const table of ["session_input", "session_message", "session_message_part", "session_run", "session_task", "permission_request"]) {
        expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(database.prepare("SELECT count(*) AS count FROM session_event WHERE session_id = ?").get(temporary.id)).toEqual({ count: 0 });
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.sessions.get(formal.id)?.id).toBe(formal.id);
        expect(reopened.sessions.get(temporary.id)).toBeUndefined();
        expect(reopened.runs.getRun(admitted.run.id)).toBeUndefined();
      } finally { reopened.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("copies formal context into temporary history without changing the source", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-fork-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "source", cwd: directory, model: "m" });
      const input = store.conversationTransactions.admitPrompt({ sessionId: "source", content: "original" });
      const message = store.conversations.createMessage({ sessionId: "source", role: "user", inputId: input.id });
      store.conversations.upsertMessagePart({ sessionId: "source", messageId: message.id, type: "text", text: "original" });
      const before = store.conversationTransactions.getSessionState("source");
      const fork = store.conversationTransactions.forkSessionWithHistory({ sourceSessionId: "source", session: { cwd: directory, model: "m", storage: "memory" } as any });
      expect(store.conversations.listMessageParts(fork.id).map((part) => part.text)).toEqual(["original"]);
      store.conversationTransactions.admitPrompt({ sessionId: fork.id, content: "temporary follow-up" });
      expect(store.conversations.listInputs("source")).toEqual(before.inputs);
      const database = (store as any).storage.database.connection;
      expect(database.prepare("SELECT count(*) AS count FROM session_input WHERE session_id = ?").get(fork.id)).toEqual({ count: 0 });
      store.conversationTransactions.deleteSessionTree(fork.id);
      expect(store.sessions.get("source")?.id).toBe("source");
      expect(store.conversations.listInputs("source")).toEqual(before.inputs);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rolls temporary changes back and preserves accepted temporary data across SQLite failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-memory-rollback-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "formal", cwd: directory, model: "m" });
      store.sessions.create({ id: "temporary", parentId: "formal", cwd: directory, model: "m", storage: "memory" } as any);
      const accepted = store.conversationTransactions.admitPrompt({ sessionId: "temporary", content: "keep" });
      const storage = (store as any).storage;
      storage.coordinator.setHooks({ beforeCommit: () => { throw new Error("commit failed"); } });
      let notified = false;
      expect(() => store.transaction(() => {
        store.conversationTransactions.admitPrompt({ sessionId: "temporary", content: "reject" });
        storage.deferUntilCommit(() => { notified = true; });
      })).toThrow("commit failed");
      expect(notified).toBe(false);
      expect(store.conversations.listInputs("temporary").map((input) => input.id)).toEqual([accepted.id]);
      expect(() => store.conversations.createMessage({ sessionId: "formal", role: "assistant" })).toThrow("commit failed");
      expect(store.sessions.get("temporary")?.id).toBe("temporary");
      expect(store.conversations.listInputs("temporary").map((input) => input.id)).toEqual([accepted.id]);
      storage.coordinator.setHooks();
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
