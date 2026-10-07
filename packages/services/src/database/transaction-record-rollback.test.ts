import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../session-runtime/store.js";
import { ConversationTransactions } from "../conversations/conversation-transactions.js";
import type { StorageContext } from "./storage-context.js";
import type { ChatPersistenceRouter } from "./chat-persistence.js";
import { GoalRepository } from "../goals/goal-repository.js";
import { createProjectionSettlement } from "../session-runtime/projection-settlements.js";

function fixture(work: (store: SessionStore, storage: StorageContext) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-tx-record-"));
  const store = new SessionStore({ path: join(directory, "store.db"), deltaFlushIntervalMs: 60_000 });
  const storage = (store as unknown as { storage: StorageContext }).storage;
  try {
    store.sessions.create({ id: "s", cwd: directory, model: "m" });
    store.conversations.createMessage({ id: "m", sessionId: "s", role: "assistant" });
    store.conversations.upsertMessagePart({ id: "p", sessionId: "s", messageId: "m", type: "text", text: "" });
    work(store, storage);
  } finally {
    vi.restoreAllMocks();
    storage.coordinator!.setHooks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const delta = { sessionId: "s", messageId: "m", partId: "p", field: "text" as const };

describe("record transaction boundaries", () => {
  it("does not read unrelated retained history or invoke full memory/control snapshots", () => {
    fixture((store, storage) => {
      const historical = storage.state.events[0]!;
      const payload = historical.payload;
      Object.defineProperty(historical, "payload", { configurable: true, enumerable: true, get() { throw new Error("unrelated history read"); } });
      vi.spyOn(storage.chatPersistence!, "snapshot").mockImplementation(() => { throw new Error("memory snapshot"); });
      vi.spyOn(storage.temporaryControls!, "snapshot").mockImplementation(() => { throw new Error("control snapshot"); });
      try {
        store.sessions.update("s", { title: "updated" });
        expect(store.sessions.get("s")!.title).toBe("updated");
      } finally { Object.defineProperty(historical, "payload", { configurable: true, enumerable: true, value: payload }); }
    });
  });

  it("captures only changed records across two temporary sessions and restores a failed commit", () => {
    fixture((store, storage) => {
      for (const id of ["a", "b"]) store.sessions.create({ id, cwd: ".", model: "m", storage: "memory" });
      const router = storage.chatPersistence as ChatPersistenceRouter;
      const before = router.snapshot();
      const unchanged = storage.state.sessions.b;
      const clone = vi.spyOn(globalThis, "structuredClone");
      storage.coordinator!.setHooks({ beforeCommit() { throw new Error("reject"); } });
      expect(() => store.sessions.update("a", { title: "rejected" })).toThrow("reject");
      expect(storage.state.sessions.a!.title).toBe("");
      expect(storage.state.sessions.b).toBe(unchanged);
      expect(clone.mock.calls.some(([value]) => value === unchanged || value === storage.state)).toBe(false);
      expect(router.snapshot()).toEqual(before);
    });
  });

  it("detaches the frame before callbacks and preserves accepted text when a callback throws", () => {
    fixture((store, storage) => {
      expect(() => store.transaction(() => {
        store.sessions.update("s", { title: "committed" });
        storage.deferUntilCommit!(() => {
          expect(storage.rollback).toBeUndefined();
          expect(storage.coordinator!.inTransaction).toBe(false);
          store.incrementalOutput.appendMessagePartDelta({ ...delta, delta: "accepted" });
          throw new Error("callback failed");
        });
      })).toThrow("callback failed");
      expect(store.sessions.get("s")!.title).toBe("committed");
      expect(storage.state.parts.p!.text).toBe("accepted");
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["p"]);
      store.incrementalOutput.flushMessagePartDeltas();
      expect(storage.database.connection.prepare("SELECT text FROM session_message_part WHERE id = 'p'").get()).toEqual({ text: "accepted" });
    });
  });

  it("rolls back a reliable callback write independently and continues the outer callback order", () => {
    fixture((store, storage) => {
      const order: string[] = [];
      store.transaction(() => {
        const outerJournal = storage.rollback!;
        store.sessions.update("s", { title: "outer committed" });
        storage.deferUntilCommit!(() => {
          order.push("outer first");
          storage.coordinator!.setHooks({ beforeCommit() {
            expect(storage.rollback).toBeDefined();
            expect(storage.rollback).not.toBe(outerJournal);
            expect(storage.database.connection.inTransaction).toBe(true);
            order.push("inner commit attempted");
            throw new Error("inner commit failed");
          } });
          try {
            expect(() => store.sessions.update("s", { title: "inner rejected" })).toThrow("inner commit failed");
          } finally { storage.coordinator!.setHooks(); }
          expect(store.sessions.get("s")!.title).toBe("outer committed");
          expect(storage.database.connection.prepare("SELECT title FROM session WHERE id = 's'").get()).toEqual({ title: "outer committed" });
          order.push("inner failure caught");
        });
        storage.deferUntilCommit!(() => { order.push("outer second"); });
      });
      expect(order).toEqual(["outer first", "inner commit attempted", "inner failure caught", "outer second"]);
      expect(store.sessions.get("s")!.title).toBe("outer committed");
      expect(storage.database.connection.prepare("SELECT title FROM session WHERE id = 's'").get()).toEqual({ title: "outer committed" });
    });
  });

  it("restores a deleted and rebuilt temporary session, its complete graph and all control maps", () => {
    fixture((store, storage) => {
      const repository = new GoalRepository(storage);
      for (const id of ["a", "b"]) {
        store.sessions.create({ id, cwd: ".", model: "m", storage: "memory" });
        store.conversationTransactions.admitPrompt({ id: `i-${id}`, sessionId: id, content: "original" });
        store.runs.createRun({ id: `r-${id}`, sessionId: id, inputId: `i-${id}` });
        store.runs.createRunAttempt({ id: `attempt-${id}`, runId: `r-${id}` });
        store.runs.createSessionTask({ id: `task-${id}`, sessionId: id, type: "shell", description: "task", cwd: "." });
        store.permissions.create({ id: `permission-${id}`, sessionId: id, toolName: "bash" });
        store.conversations.createMessage({ id: `m-${id}`, sessionId: id, role: "assistant" });
        store.conversations.upsertMessagePart({ id: `p-${id}`, sessionId: id, messageId: `m-${id}`, type: "text", text: "original" });
        store.incrementalOutput.appendMessagePartDelta({ sessionId: id, messageId: `m-${id}`, partId: `p-${id}`, field: "text", delta: " accepted" });
        repository.insertGoal({ id: `goal-${id}`, sessionId: id, objective: "finish", maxAutoTurns: 2 });
        repository.beginRequest({ requestId: `request-${id}`, sessionId: id, fingerprint: "same" });
        repository.recordAssessment({ goalId: `goal-${id}`, revision: 0, runId: `r-${id}`, assessment: { verifiedSignatures: ["saved"] } });
        repository.recordContinuation({ goalId: `goal-${id}`, revision: 0, previousRunId: "previous", inputId: `i-${id}`, runId: `r-${id}` });
        createProjectionSettlement(storage.database.orm, { id: `settlement-${id}`, projector: "execution", rootSessionId: id, eventSequence: 2, action: "retry-terminal-projection", payload: {} }, storage.temporaryControls, "memory");
      }
      const before = structuredClone(storage.state);
      const memory = storage.chatPersistence!.snapshot();
      const controls = storage.temporaryControls!.snapshot();
      const unchanged = storage.state.parts["p-b"];
      storage.coordinator!.setHooks({ beforeCommit() { throw new Error("reject rebuild"); } });
      store.conversationTransactions.setTestHooks({ afterDeleteMemory() {
        expect(storage.chatPersistence!.isTemporary("a")).toBe(true);
        store.sessions.create({ id: "a", cwd: ".", model: "m", storage: "memory" });
        store.conversations.createMessage({ id: "m-a", sessionId: "a", role: "assistant" });
        store.conversations.upsertMessagePart({ id: "p-a", sessionId: "a", messageId: "m-a", type: "text", text: "rebuilt" });
        repository.insertGoal({ id: "goal-a", sessionId: "a", objective: "rebuilt", maxAutoTurns: 1 });
      } });
      try {
        expect(() => store.conversationTransactions.deleteSessionTree("a")).toThrow("reject rebuild");
      } finally { store.conversationTransactions.setTestHooks(); }
      expect(storage.state).toEqual(before);
      expect(storage.state.parts["p-b"]).toBe(unchanged);
      expect(storage.chatPersistence!.snapshot()).toEqual(memory);
      expect(storage.temporaryControls!.snapshot()).toEqual(controls);
    });
  });

  it("preserves accepted callback text and dirty checkpoint after the follow-up save fails, then retries", () => {
    fixture((store, storage) => {
      let first = true;
      storage.coordinator!.setHooks({ beforeCommit() {
        if (!first) throw new Error("follow-up save failed");
        first = false;
        storage.deferUntilCommit!(() => store.incrementalOutput.appendMessagePartDelta({ ...delta, delta: "accepted" }));
      } });
      expect(() => store.sessions.update("s", { title: "committed" })).toThrow("follow-up save failed");
      expect(storage.state.parts.p!.text).toBe("accepted");
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["p"]);
      expect(storage.database.connection.prepare("SELECT text FROM session_message_part WHERE id = 'p'").get()).toEqual({ text: "" });
      storage.coordinator!.setHooks();
      store.incrementalOutput.flushMessagePartDeltas();
      expect(storage.database.connection.prepare("SELECT text FROM session_message_part WHERE id = 'p'").get()).toEqual({ text: "accepted" });
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
    });
  });

  it.each(["admission", "replace"] as const)("rejects a composite %s without save before any work after owner takeover", (kind) => {
    fixture((store, storage) => {
      const transactions = new ConversationTransactions({ storage, conversations: store.conversations });
      const before = structuredClone(storage.state);
      store.acquireApplicationOwner({ ownerId: "first", pid: 1, staleAfterMs: 1000 });
      storage.database.connection.prepare("UPDATE application_owner SET owner_id = 'second', generation = generation + 1 WHERE key = 'application'").run();
      let touched = false;
      transactions.setTestHooks({ afterInputWrite() { touched = true; }, afterTranscriptReplacement() { touched = true; } });
      expect(() => {
        if (kind === "admission") transactions.admitPrompt({ id: "new", sessionId: "s", content: "rejected" });
        else transactions.replaceTranscript({ sessionId: "s", messages: [] });
      }).toThrow("Data directory is already owned by second");
      expect(touched).toBe(false);
      expect(storage.state).toEqual(before);
    });
  });

  it("tries every restoration and rollback callback while retaining the original error", () => {
    fixture((store, storage) => {
      const cause = new Error("original failure");
      const order: string[] = [];
      const values: Record<string, number> = { first: 1, blocked: 2, last: 3 };
      let caught: unknown;
      try {
        store.transaction(() => {
          for (const key of Object.keys(values)) storage.rollback!.capture(values, key);
          values.first = 10;
          values.last = 30;
          Object.defineProperty(values, "blocked", { set() { order.push("blocked"); throw new Error("restore failed"); } });
          storage.coordinator!.deferUntilRollback(() => { order.push("callback1"); });
          storage.coordinator!.deferUntilRollback(() => { order.push("callback2"); throw new Error("callback failed"); });
          throw cause;
        });
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toContain(cause);
      expect(values.first).toBe(1);
      expect(values.last).toBe(3);
      expect(order).toEqual(["blocked", "callback2", "callback1"]);
      expect(storage.rollback).toBeUndefined();
      expect(storage.coordinator!.inTransaction).toBe(false);
    });
  });
});
