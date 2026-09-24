import { Buffer } from "node:buffer";
import type { AppendEventInput, AppendMessagePartDeltaInput, SessionEventRecord } from "@vykor/protocol";
import type { StorageContext } from "../database/storage-context.js";
import { assertMessage, assertSession, clone, now } from "../session-runtime/store-state.js";

export interface IncrementalOutputOptions {
  storage: StorageContext;
  appendTransientEvent(input: AppendEventInput): SessionEventRecord;
}

export class IncrementalOutput {
  constructor(private readonly options: IncrementalOutputOptions) {}

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
    part.text = `${part.text ?? ""}${input.delta}`;
    part.updatedAt = timestamp;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
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
    const { storage } = this.options;
    const updatePart = storage.database.connection.prepare("UPDATE session_message_part SET text = ?, updated_at = ? WHERE id = ?");
    const updateMessage = storage.database.connection.prepare("UPDATE session_message SET updated_at = ? WHERE id = ?");
    const updateSession = storage.database.connection.prepare("UPDATE session SET updated_at = ? WHERE id = ?");
    const messageIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const id of partIds) {
      const part = storage.state.parts[id];
      if (!part) continue;
      updatePart.run(part.text ?? "", part.updatedAt, id);
      messageIds.add(part.messageId);
      sessionIds.add(part.sessionId);
    }
    for (const id of messageIds) { const row = storage.state.messages[id]; if (row) updateMessage.run(row.updatedAt, id); }
    for (const id of sessionIds) { const row = storage.state.sessions[id]; if (row) updateSession.run(row.updatedAt, id); }
  }
}
