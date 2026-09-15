import type {
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  SessionEventRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import { assertSession, clone } from "../session-runtime/store-state.js";

export class ConversationRepository {
  constructor(private readonly storage: StorageContext) {}

  getInput(inputId: string): SessionInputRecord | undefined {
    const input = this.storage.state.inputs[inputId];
    return input ? clone(input) : undefined;
  }

  listInputAttachments(inputId: string): SessionInputAttachmentRecord[] {
    return clone(
      Object.values(this.storage.state.inputAttachments)
        .filter((reference) => reference.inputId === inputId)
        .sort((left, right) => left.seq - right.seq),
    );
  }

  listSessionInputAttachments(
    sessionId: string,
  ): SessionInputAttachmentRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.inputAttachments)
        .filter((reference) => reference.sessionId === sessionId)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.seq - right.seq,
        ),
    );
  }

  countInputAttachmentReferences(assetId: string): number {
    return Object.values(this.storage.state.inputAttachments).filter(
      (reference) => reference.assetId === assetId,
    ).length;
  }

  countAttachmentReferences(assetId: string): number {
    const inputReferences = this.countInputAttachmentReferences(assetId);
    const messageReferences = Object.values(this.storage.state.parts).filter(
      (part) => part.type === "attachment" && part.assetId === assetId,
    ).length;
    return inputReferences + messageReferences;
  }

  listInputs(sessionId: string): SessionInputRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.inputs)
        .filter((input) => input.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  listMessages(
    sessionId: string,
    options: ListMessagesOptions = {},
  ): SessionMessageRecord[] {
    assertSession(this.storage.state, sessionId);
    let messages = Object.values(this.storage.state.messages)
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.afterSeq !== undefined)
      messages = messages.filter((message) => message.seq > options.afterSeq!);
    if (options.limit !== undefined)
      messages = messages.slice(0, options.limit);
    return clone(messages);
  }

  listMessageParts(
    sessionId: string,
    options: ListMessagePartsOptions = {},
  ): SessionMessagePartRecord[] {
    assertSession(this.storage.state, sessionId);
    let parts = Object.values(this.storage.state.parts)
      .filter((part) => part.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.messageId)
      parts = parts.filter((part) => part.messageId === options.messageId);
    if (options.afterSeq !== undefined)
      parts = parts.filter((part) => part.seq > options.afterSeq!);
    if (options.limit !== undefined) parts = parts.slice(0, options.limit);
    return clone(parts);
  }

  listEvents(options: ListEventsOptions = {}): SessionEventRecord[] {
    let events = this.storage.state.events;
    if (options.afterSeq !== undefined)
      events = events.filter((event) => event.seq > options.afterSeq!);
    if (options.sessionId) {
      events = events.filter(
        (event) =>
          event.sessionId === undefined ||
          event.sessionId === options.sessionId,
      );
    }
    events = events.sort((a, b) => a.seq - b.seq);
    if (options.limit !== undefined) events = events.slice(0, options.limit);
    return clone(events);
  }

  latestEventSeq(): number {
    return this.storage.state.nextEventSeq - 1;
  }
}
