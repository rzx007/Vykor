import { describe, expect, it } from "vitest";
import { emptyState, type SessionState } from "../session-runtime/store-state.js";
import { MemoryChatPersistence } from "./chat-persistence.js";
import { createMutationBuffer } from "./mutation-buffer.js";
import { TransactionJournal } from "./transaction-journal.js";

function chatState(): SessionState {
  const state = emptyState();
  state.sessions.temporary = { id: "temporary", storage: "memory", cwd: ".", title: "original", model: "m", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 };
  state.messages.message = { id: "message", sessionId: "temporary", seq: 1, role: "assistant", metadata: {}, createdAt: 1, updatedAt: 1 };
  state.parts.part = { id: "part", sessionId: "temporary", messageId: "message", seq: 1, type: "text", status: "running", text: "", metadata: {}, createdAt: 1, updatedAt: 1 };
  state.events = [{ id: "old", sessionId: "temporary", seq: 1, type: "session.updated", schemaVersion: 1, payload: { value: "historical" }, createdAt: 1 }];
  state.nextEventSeq = 2;
  return state;
}

describe("memory chat record rollback", () => {
  it("restores the first values after commit deletions, replacements, and event appends", () => {
    let journal: TransactionJournal | undefined;
    const memory = new MemoryChatPersistence(() => journal);
    const state = chatState();
    memory.restore(state);
    journal = new TransactionJournal();
    const removed = createMutationBuffer();
    removed.deletedParts.add("part");
    memory.commit(state, removed);
    state.parts.part!.text = "recreated";
    state.sessions.temporary!.title = "changed";
    state.sessions.added = { ...state.sessions.temporary!, id: "added" };
    state.events.push({ ...state.events[0]!, id: "new", seq: 2 });
    state.nextEventSeq = 3;
    const changes = createMutationBuffer();
    changes.sessions.add("temporary").add("added");
    changes.parts.add("part");
    changes.events.add("new");
    memory.commit(state, changes);
    journal.rollback();
    expect(memory.load()).toEqual(chatState());
  });

  it("preserves accepted checkpoints and restores rejected part, message, and session values", () => {
    let journal: TransactionJournal | undefined;
    const memory = new MemoryChatPersistence(() => journal);
    const state = chatState();
    memory.restore(state);
    state.parts.part!.text = "accepted";
    state.messages.message!.updatedAt = 2;
    state.sessions.temporary!.updatedAt = 2;
    memory.checkpoint(state, ["part"]);
    const accepted = memory.snapshot();
    journal = new TransactionJournal();
    state.parts.part!.text = "accepted rejected";
    state.messages.message!.updatedAt = 3;
    state.sessions.temporary!.updatedAt = 3;
    memory.checkpoint(state, ["part"]);
    journal.rollback();
    expect(memory.load()).toEqual(accepted);
  });

  it("restores deleted sessions and the original events array without copying historical rows", () => {
    let journal: TransactionJournal | undefined;
    const memory = new MemoryChatPersistence(() => journal);
    memory.restore(chatState());
    const records = (memory as unknown as { records: SessionState }).records;
    const events = records.events;
    const historical = events[0]!;
    Object.defineProperty(historical.payload, "unrelated", { enumerable: true, configurable: true, get() { throw new Error("historical event copied"); } });
    journal = new TransactionJournal();
    memory.deleteSessions(["temporary"]);
    memory.checkpoint(chatState(), ["part"]);
    journal.rollback();
    expect(records.events === events).toBe(true);
    expect(records.events[0]).toBe(historical);
    delete historical.payload.unrelated;
    expect(memory.load()).toEqual(chatState());
  });
});
