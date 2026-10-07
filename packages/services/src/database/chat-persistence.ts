import type { SessionState } from "../session-runtime/store-state.js";
import { emptyState } from "../session-runtime/store-state.js";
import { createMutationBuffer, type MutationBuffer } from "./mutation-buffer.js";
import type { StorageContext } from "./storage-context.js";
import { SqliteChatPersistence } from "./sqlite-chat-persistence.js";
import type { DurableEventRegistry } from "../session-runtime/event-registry.js";
import type { TransactionJournal } from "./transaction-journal.js";

const tables = ["sessions", "inputs", "inputAttachments", "messages", "parts", "runs", "attempts", "tasks", "permissions"] as const;
type ChatTable = typeof tables[number];

/** Sync transactions must never announce a Promise-valued commit as successful. */
export function assertSynchronousCommit(result: unknown): void {
  if (result && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Chat persistence returned an asynchronous result; an awaited transaction is required");
  }
}
const deletions = {
  deletedInputAttachments: "inputAttachments", deletedParts: "parts", deletedMessages: "messages",
  deletedAttempts: "attempts", deletedRuns: "runs", deletedInputs: "inputs",
} as const;

/** Chat records use a separate persistence boundary from attachments and workflows. */
export interface ChatPersistence {
  load(eventRegistry: DurableEventRegistry): SessionState;
  commit(state: SessionState, changes: MutationBuffer): void;
  checkpoint(state: SessionState, partIds: string[]): void;
  deleteSessions(sessionIds: string[]): void;
}

export interface ChatStoragePersistence {
  isTemporary(sessionId: string): boolean;
  commit(): void;
  checkpoint(partIds: string[]): void;
  deleteSessions(sessionIds: string[]): void;
  snapshot(): SessionState;
  restore(snapshot: SessionState): void;
  restoreTemporaryState(state: SessionState): void;
}

/** Actual JS records, with no SQLite connection or filesystem dependency. */
export class MemoryChatPersistence implements ChatPersistence {
  private records = emptyState();

  constructor(private readonly journal?: () => TransactionJournal | undefined) {}

  snapshot(): SessionState { return structuredClone(this.records); }
  load(): SessionState { return this.snapshot(); }
  restore(snapshot: SessionState): void { this.records = structuredClone(snapshot); }
  owns(table: ChatTable, id: string): boolean { return id in this.records[table]; }

  commit(state: SessionState, changes: MutationBuffer): void {
    for (const table of tables) {
      const target = this.records[table] as Record<string, unknown>;
      for (const id of changes[table]) {
        const value = state[table][id];
        if (value) {
          this.journal?.()?.capture(target, id);
          target[id] = structuredClone(value);
        }
      }
    }
    for (const [mutation, table] of Object.entries(deletions)) {
      for (const id of changes[mutation as keyof typeof deletions]) {
        this.journal?.()?.capture(this.records[table], id);
        delete this.records[table][id];
      }
    }
    const eventIds = new Set(this.records.events.map((event) => event.id));
    for (const event of state.events) {
      if (!changes.events.has(event.id)) continue;
      if (eventIds.has(event.id)) throw new Error(`Session event already exists: ${event.id}`);
      this.journal?.()?.captureEvents(this.records);
      this.records.events.push(structuredClone(event));
      eventIds.add(event.id);
    }
    this.journal?.()?.capture(this.records, "nextEventSeq");
    this.records.nextEventSeq = state.nextEventSeq;
  }

  checkpoint(state: SessionState, partIds: string[]): void {
    for (const id of partIds) {
      const part = state.parts[id];
      if (!part) continue;
      this.journal?.()?.capture(this.records.parts, id);
      this.records.parts[id] = structuredClone(part);
      const message = state.messages[part.messageId];
      const session = state.sessions[part.sessionId];
      if (message) {
        this.journal?.()?.capture(this.records.messages, message.id);
        this.records.messages[message.id] = structuredClone(message);
      }
      if (session) {
        this.journal?.()?.capture(this.records.sessions, session.id);
        this.records.sessions[session.id] = structuredClone(session);
      }
    }
  }

  deleteSessions(sessionIds: string[]): void {
    const ids = new Set(sessionIds);
    const runs = new Set(Object.values(this.records.runs).filter((row) => ids.has(row.sessionId)).map((row) => row.id));
    for (const table of tables) {
      for (const [id, value] of Object.entries(this.records[table])) {
        const row = value as { id: string; sessionId?: string; runId?: string };
        if ((table === "sessions" && ids.has(id)) || (row.sessionId && ids.has(row.sessionId)) || (table === "attempts" && row.runId && runs.has(row.runId))) {
          this.journal?.()?.capture(this.records[table], id);
          delete this.records[table][id];
        }
      }
    }
    this.journal?.()?.captureEvents(this.records);
    this.records.events = this.records.events.filter((row) => !row.sessionId || !ids.has(row.sessionId));
  }
}

export class ChatPersistenceRouter implements ChatStoragePersistence {
  readonly memory: MemoryChatPersistence;
  private readonly sqlite: ChatPersistence;

  constructor(private readonly storage: StorageContext) {
    this.memory = new MemoryChatPersistence(() => this.storage.rollback);
    this.sqlite = new SqliteChatPersistence(storage.database);
  }

  snapshot(): SessionState { return this.memory.snapshot(); }
  restore(snapshot: SessionState): void { this.memory.restore(snapshot); }

  isTemporary(sessionId: string): boolean {
    const session = this.storage.state.sessions[sessionId]
      ?? this.storage.rollback?.previous(this.storage.state.sessions, sessionId);
    return session?.storage === "memory" || this.memory.owns("sessions", sessionId);
  }

  private rowIsTemporary(table: ChatTable, id: string): boolean {
    const row = (this.storage.state[table][id]
      ?? this.storage.rollback?.previous(this.storage.state[table], id)) as
      { sessionId?: string; runId?: string } | undefined;
    if (table === "sessions") return this.isTemporary(id);
    if (row?.sessionId) return this.isTemporary(row.sessionId);
    if (row?.runId) {
      const run = this.storage.state.runs[row.runId]
        ?? this.storage.rollback?.previous(this.storage.state.runs, row.runId);
      if (run) return this.isTemporary(run.sessionId);
    }
    return this.memory.owns(table, id);
  }

  commit(): void {
    const state = this.storage.state;
    const temporary = createMutationBuffer();
    const durable = createMutationBuffer();
    for (const table of tables) {
      for (const id of this.storage.mutations[table]) (this.rowIsTemporary(table, id) ? temporary : durable)[table].add(id);
    }
    for (const [mutation, table] of Object.entries(deletions)) {
      for (const id of this.storage.mutations[mutation as keyof typeof deletions]) {
        (this.rowIsTemporary(table, id) ? temporary : durable)[mutation as keyof typeof deletions].add(id);
      }
    }
    const durableEvents: SessionState["events"] = [];
    for (const event of state.events) {
      if (!this.storage.mutations.events.has(event.id)) continue;
      const deletedIds = event.type === "session.deleted" && Array.isArray(event.payload.sessionIds)
        ? event.payload.sessionIds as string[] : undefined;
      const memoryEvent = event.sessionId ? this.isTemporary(event.sessionId) : deletedIds?.every((id) => this.isTemporary(id));
      (memoryEvent ? temporary : durable).events.add(event.id);
      if (!memoryEvent) durableEvents.push(deletedIds
        ? { ...event, payload: { ...event.payload, sessionIds: deletedIds.filter((id) => !this.isTemporary(id)) } }
        : event);
    }
    assertSynchronousCommit(this.sqlite.commit({ ...state, events: durableEvents }, durable));
    assertSynchronousCommit(this.memory.commit(state, temporary));
  }

  checkpoint(partIds: string[]): void {
    const memory: string[] = [];
    const durable: string[] = [];
    for (const id of partIds) (this.rowIsTemporary("parts", id) ? memory : durable).push(id);
    if (durable.length) assertSynchronousCommit(this.sqlite.checkpoint(this.storage.state, durable));
    if (memory.length) assertSynchronousCommit(this.memory.checkpoint(this.storage.state, memory));
  }

  deleteSessions(sessionIds: string[]): void {
    const durable = sessionIds.filter((id) => !this.isTemporary(id));
    if (durable.length) assertSynchronousCommit(this.sqlite.deleteSessions(durable));
    assertSynchronousCommit(this.memory.deleteSessions(sessionIds));
    for (const id of sessionIds) this.storage.temporaryControls?.deleteSession(id);
  }

  restoreTemporaryState(state: SessionState): void {
    const memory = this.memory.load();
    for (const table of tables) Object.assign(state[table], memory[table]);
    state.events.push(...memory.events);
    state.events.sort((a, b) => a.seq - b.seq);
    state.nextEventSeq = Math.max(state.nextEventSeq, memory.nextEventSeq);
  }
}
