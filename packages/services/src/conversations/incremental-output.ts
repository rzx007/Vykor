import { Buffer } from "node:buffer";
import type { AppendEventInput, AppendMessagePartDeltaInput, SessionEventRecord } from "@vykor/protocol";
import type { StorageContext } from "../database/storage-context.js";
import { assertSynchronousCommit } from "../database/chat-persistence.js";
import { assertMessage, assertSession, clone, now } from "../session-runtime/store-state.js";

export interface IncrementalOutputOptions {
  storage: StorageContext;
  appendTransientEvent(input: AppendEventInput): SessionEventRecord;
}

export class IncrementalOutput {
  constructor(private readonly options: IncrementalOutputOptions) {}

  updateRunToolGeneration(runId: string, entries: Record<string, unknown>[]): SessionEventRecord {
    const { storage } = this.options;
    const run = storage.state.runs[runId];
    if (!run) throw new Error(`Session run not found: ${runId}`);
    assertSession(storage.state, run.sessionId);
    const toolGeneration = clone(entries);
    const updatedAt = now();
    const event = this.options.appendTransientEvent({
      type: "session.run.updated",
      sessionId: run.sessionId,
      payload: {
        run: clone({ ...run, updatedAt, metadata: { ...run.metadata, toolGeneration } }),
        previousStatus: run.status,
      },
    });
    storage.rollback?.capture(storage.state.runs, run.id);
    run.metadata = { ...run.metadata, toolGeneration };
    run.updatedAt = updatedAt;
    return event;
  }

  appendMessagePartDelta(input: AppendMessagePartDeltaInput): SessionEventRecord {
    const { storage } = this.options;
    const session = assertSession(storage.state, input.sessionId);
    const message = assertMessage(storage.state, input.messageId);
    const part = storage.state.parts[input.partId];
    if (!part) throw new Error(`Session message part not found: ${input.partId}`);
    if (message.sessionId !== input.sessionId || part.sessionId !== input.sessionId || part.messageId !== input.messageId) {
      throw new Error(`Session message part ${input.partId} does not belong to message ${input.messageId}`);
    }
    const event = this.options.appendTransientEvent({ type: "session.message.part.delta", sessionId: input.sessionId, payload: { ...input } });
    const timestamp = now();
    storage.rollback?.capture(storage.state.parts, part.id);
    storage.rollback?.capture(storage.state.messages, message.id);
    storage.rollback?.capture(storage.state.sessions, session.id);
    part.text = `${part.text ?? ""}${input.delta}`;
    part.updatedAt = timestamp;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    if (session.storage === "memory") {
      // Accepted temporary text must survive a reload after an unrelated SQLite save fails.
      this.persist([part.id]);
      return clone(event);
    }
    const reached = storage.deltaCheckpoint.markDirty(part.id, Buffer.byteLength(input.delta, "utf8"));
    if (!storage.coordinator?.inTransaction) {
      if (reached) this.flushMessagePartDeltas();
      else storage.deltaCheckpoint.schedule();
    }
    return clone(event);
  }

  flushMessagePartDeltas(): void {
    const { storage } = this.options;
    const partIds = storage.deltaCheckpoint.dirtyPartIds();
    if (partIds.length === 0) return;
    const flush = () => this.persist(partIds);
    if (storage.coordinator?.inTransaction) flush();
    else storage.database.connection.transaction(flush)();
    for (const id of partIds) storage.deltaCheckpoint.delete(id);
  }

  close(): void {
    try {
      this.flushMessagePartDeltas();
    } finally {
      this.options.storage.deltaCheckpoint.close();
    }
  }

  private persist(partIds: string[]): void {
    const persistence = this.options.storage.chatPersistence;
    if (!persistence) throw new Error("Chat persistence is not configured");
    assertSynchronousCommit(persistence.checkpoint(partIds));
  }
}
