import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { StorageContext } from "../database/storage-context.js";
import { RunRepository } from "../runs/run-repository.js";
import { SessionRepository } from "../sessions/session-repository.js";
import { SessionStore } from "../session-runtime/store.js";
import { ConversationRepository } from "./conversation-repository.js";

function fixture(work: (store: SessionStore, storage: StorageContext, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-record-rollback-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  try {
    store.sessions.create({ id: "s1", cwd: directory, model: "m" });
    store.conversations.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
    store.conversations.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "accepted" });
    store.runs.createRun({ id: "r1", sessionId: "s1" });
    work(store, (store as unknown as { storage: StorageContext }).storage, directory);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// Inspect the actual transaction journal before the coordinator handles abort.
function expectRecordRollback(store: SessionStore, storage: StorageContext, work: () => void): void {
  const before = structuredClone(storage.state);
  expect(() => store.transaction(() => {
    const journal = storage.rollback!;
    work();
    journal.rollback();
    for (const table of ["sessions", "inputs", "inputAttachments", "messages", "parts", "runs", "attempts", "tasks", "permissions", "events"] as const) {
      expect(storage.state[table], table).toEqual(before[table]);
    }
    throw new Error("abort record test");
  })).toThrow("abort record test");
}

function readyAttachment(store: SessionStore): void {
  store.attachments.createImportingAttachment({ id: "asset1", displayName: "doc.txt", declaredMediaType: "text/plain", stagingName: "doc.part", createdAt: 10 });
  store.attachments.markAttachmentReady("asset1", { sha256: "a".repeat(64), sizeBytes: 50, mediaType: "text/plain", updatedAt: 11 });
}

describe("business record rollback", () => {
  it.each(["session", "run", "message", "part"] as const)("rolls back an independent %s write on commit failure, including reopen", (kind) => {
    fixture((store, storage, directory) => {
      const before = structuredClone(storage.state);
      const sessions = new SessionRepository({ storage, projects: store.projects });
      const runs = new RunRepository(storage);
      const conversations = new ConversationRepository(storage);
      storage.coordinator!.setHooks({ beforeCommit: () => { throw new Error("commit failed"); } });
      const write = () => {
        if (kind === "session") sessions.update("s1", { title: "failed title" });
        if (kind === "run") runs.updateRun("r1", { status: "running", metadata: { failed: true } });
        if (kind === "message") conversations.createMessage({ id: "failed", sessionId: "s1", role: "user" });
        if (kind === "part") conversations.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "failed text" });
      };
      expect(write).toThrow("commit failed");
      expect(storage.state).toEqual(before);
      storage.coordinator!.setHooks();
      const reopened = new SessionStore({ path: join(directory, "store.db") });
      try {
        expect(reopened.sessions.get("s1")).toEqual(before.sessions.s1);
        expect(reopened.runs.getRun("r1")).toEqual(before.runs.r1);
        expect(reopened.conversations.listMessages("s1")).toEqual(Object.values(before.messages));
        expect(reopened.conversations.listMessageParts("s1")).toEqual(Object.values(before.parts));
        expect(reopened.conversations.listEvents()).toEqual(before.events);
      } finally { reopened.close(); }
    });
  });

  it("keeps event payloads independent of later business writes, inputs and retained return values", () => {
    fixture((store, storage) => {
      const payload = { session: { ...store.sessions.get("s1")!, metadata: { nested: { value: "original" } } } };
      const event = store.conversations.appendEventInMemory({ type: "session.updated", sessionId: "s1", payload });
      payload.session.metadata.nested.value = "caller mutation";
      (event.payload.session as typeof payload.session).metadata.nested.value = "return mutation";
      store.runs.updateRun("r1", { status: "running" });
      expect(storage.state.events.find(({ id }) => id === event.id)!.payload).toMatchObject({ session: { metadata: { nested: { value: "original" } } } });
      expect(storage.state.events.find(({ type }) => type === "session.run.created")!.payload).toMatchObject({ run: { status: "pending" } });
    });
  });

  it.each(["session", "run", "message", "part", "event"] as const)("rejects an independent %s write before changing memory or SQLite after owner takeover", (kind) => {
    fixture((store, storage, directory) => {
      const before = structuredClone(storage.state);
      store.acquireApplicationOwner({ ownerId: "first", pid: 1, staleAfterMs: 1000 });
      storage.database.connection.prepare("UPDATE application_owner SET owner_id = ?, generation = generation + 1 WHERE key = 'application'").run("second");
      const sessions = new SessionRepository({ storage, projects: store.projects });
      const runs = new RunRepository(storage);
      const conversations = new ConversationRepository(storage);
      expect(() => {
        if (kind === "session") sessions.update("s1", { title: "fenced" });
        if (kind === "run") runs.updateRun("r1", { status: "running" });
        if (kind === "message") conversations.createMessage({ id: "fenced", sessionId: "s1", role: "user" });
        if (kind === "part") conversations.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "fenced" });
        if (kind === "event") conversations.appendEvent({ type: "session.closing", sessionId: "s1", payload: { sessionId: "s1" } });
      }).toThrow("Data directory is already owned by second");
      expect(storage.state).toEqual(before);
      const reopened = new SessionStore({ path: join(directory, "store.db") });
      try {
        // Reopening skips the event sequence's reserved block; compare durable
        // records and retained events rather than the in-process cursor.
        expect(reopened.sessions.get("s1")).toEqual(before.sessions.s1);
        expect(reopened.runs.getRun("r1")).toEqual(before.runs.r1);
        expect(reopened.conversations.listMessages("s1")).toEqual(Object.values(before.messages));
        expect(reopened.conversations.listMessageParts("s1")).toEqual(Object.values(before.parts));
        expect(reopened.conversations.listEvents()).toEqual(before.events);
      }
      finally { reopened.close(); }
    });
  });

  it("sorts queried events without rearranging retained history", () => {
    fixture((store, storage) => {
      storage.state.events.reverse();
      const retainedOrder = storage.state.events.map(({ id }) => id);
      const queried = store.conversations.listEvents();
      expect(queried.map(({ seq }) => seq)).toEqual([...queried.map(({ seq }) => seq)].sort((a, b) => a - b));
      expect(storage.state.events.map(({ id }) => id)).toEqual(retainedOrder);
    });
  });

  it("restores first values of session, run, attempt, task runId, permission answer, and streaming rows", () => {
    fixture((store, storage, directory) => {
      store.runs.createRunAttempt({ id: "a1", runId: "r1" });
      store.runs.createRun({ id: "r2", sessionId: "s1" });
      store.runs.createSessionTask({ id: "t1", sessionId: "s1", type: "shell", description: "task", cwd: directory, runId: "r1" });
      store.permissions.create({ id: "q1", sessionId: "s1", toolName: "bash", payload: { nested: { value: "original" } } });
      expectRecordRollback(store, storage, () => {
        store.sessions.update("s1", { title: "first" });
        store.sessions.update("s1", { title: "second" });
        store.runs.updateRun("r1", { status: "running" });
        store.runs.updateRunAttempt("a1", { status: "running" });
        store.runs.updateSessionTask("t1", { runId: "r2", status: "completed" });
        store.permissions.reply({ requestId: "q1", status: "approved", answer: { nested: ["answer"] } });
        store.incrementalOutput.updateRunToolGeneration("r1", [{ name: "bash" }]);
        store.incrementalOutput.appendMessagePartDelta({ sessionId: "s1", messageId: "m1", partId: "p1", field: "text", delta: " rejected" });
      });
    });
  });

  it("restores replacement deletes and newly admitted records", () => {
    fixture((store, storage) => {
      expectRecordRollback(store, storage, () => {
        store.conversationTransactions.replaceTranscript({ sessionId: "s1", messages: [{ role: "user", parts: [{ type: "text", text: "replacement" }] }] });
        store.conversations.createMessage({ id: "m1", sessionId: "s1", role: "user" });
        store.conversations.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "rebuilt" });
        store.conversationTransactions.admitPrompt({ id: "new-input", sessionId: "s1", items: [{ type: "text", text: "new input" }] });
      });
    });
  });

  it("removes newly created rows and attachment references and restores session archive fields", () => {
    fixture((store, storage, directory) => {
      readyAttachment(store);
      expectRecordRollback(store, storage, () => {
        store.sessions.create({ id: "child", parentId: "s1", cwd: directory, model: "m", storage: "memory" });
        const input = store.conversationTransactions.admitPrompt({ id: "i2", sessionId: "child", content: "attached", attachments: [{ assetId: "asset1" }] });
        store.runs.createRun({ id: "r2", sessionId: "child", inputId: input.id });
        store.runs.createRunAttempt({ id: "a2", runId: "r2" });
        store.runs.createSessionTask({ id: "t2", sessionId: "child", type: "shell", description: "new task", cwd: directory });
        store.permissions.create({ id: "q2", sessionId: "child", toolName: "bash" });
        store.conversations.createMessage({ id: "m2", sessionId: "child", role: "user" });
        store.conversations.upsertMessagePart({ id: "p2", sessionId: "child", messageId: "m2", type: "text", text: "new" });
        store.sessions.beginArchive("s1");
        store.sessions.archive("s1");
      });
    });
  });

  it("restores an edited prompt graph including deleted and rebuilt input and run IDs", () => {
    fixture((store, storage) => {
      readyAttachment(store);
      store.runs.updateRun("r1", { status: "completed" });
      const input = store.conversationTransactions.admitPrompt({ id: "i2", sessionId: "s1", content: "original", attachments: [{ assetId: "asset1" }] });
      store.runs.createRun({ id: "r2", sessionId: "s1", inputId: input.id });
      store.runs.createRunAttempt({ id: "a2", runId: "r2" });
      store.conversations.createMessage({ id: "m2", sessionId: "s1", inputId: input.id, runId: "r2", role: "user" });
      store.conversations.upsertMessagePart({ id: "p2", sessionId: "s1", messageId: "m2", type: "text", text: "original" });
      expectRecordRollback(store, storage, () => {
        store.conversationTransactions.replaceLatestPromptWithAdmission({
          sessionId: "s1", sourceMessageId: "m2", createRun: true,
          admission: { prompt: { id: "i2", sessionId: "s1", content: "replacement", attachments: [{ assetId: "asset1" }] }, run: { id: "r2" } },
        });
      });
    });
  });

  it("restores every deleted parent and child row and the original event array", () => {
    fixture((store, storage, directory) => {
      readyAttachment(store);
      store.sessions.create({ id: "child", parentId: "s1", cwd: directory, model: "m", storage: "memory" });
      const input = store.conversationTransactions.admitPrompt({ id: "i2", sessionId: "child", content: "original", attachments: [{ assetId: "asset1" }] });
      store.runs.createRun({ id: "r2", sessionId: "child", inputId: input.id });
      store.runs.createRunAttempt({ id: "a2", runId: "r2" });
      store.runs.createSessionTask({ id: "t2", sessionId: "child", type: "shell", description: "task", cwd: directory });
      store.permissions.create({ id: "q2", sessionId: "child", toolName: "bash" });
      store.conversations.createMessage({ id: "m2", sessionId: "child", role: "user" });
      store.conversations.upsertMessagePart({ id: "p2", sessionId: "child", messageId: "m2", type: "text", text: "original" });
      const before = structuredClone(storage.state);
      const events = storage.state.events;
      store.conversationTransactions.setTestHooks({ afterDeleteMemory: () => {
        storage.rollback!.rollback();
        expect(storage.state.events).toBe(events);
        for (const table of ["sessions", "inputs", "inputAttachments", "messages", "parts", "runs", "attempts", "tasks", "permissions", "events"] as const) {
          expect(storage.state[table], table).toEqual(before[table]);
        }
        throw new Error("abort tree test");
      } });
      try { expect(() => store.conversationTransactions.deleteSessionTree("s1")).toThrow("abort tree test"); }
      finally { store.conversationTransactions.setTestHooks(); }
    });
  });

  it("restores session directories changed by a project rebind", () => {
    fixture((store, storage, directory) => {
      const projectId = store.sessions.get("s1")!.projectId;
      store.sessions.create({ id: "child", parentId: "s1", cwd: join(directory, "subdir"), model: "m" });
      expectRecordRollback(store, storage, () => { store.projects.rebind(projectId, `${directory}-next`); });
    });
  });
});
