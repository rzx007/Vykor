import { randomUUID } from "node:crypto";

import type {
  AppendEventInput,
  CreateMessageInput,
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  SessionEventRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  UpsertMessagePartInput,
} from "@vykor/protocol";

import type { StorageContext } from "../database/storage-context.js";
import {
  type DurableEventRegistry,
  defaultDurableEventRegistry,
} from "../session-runtime/event-registry.js";
import {
  assertMessage,
  assertSession,
  clone,
  maxSeq,
  now,
} from "../session-runtime/store-state.js";

export interface ConversationRepositoryOptions {
  storage: StorageContext;
  eventRegistry?: DurableEventRegistry;
  save?: () => void;
}

export class ConversationRepository {
  private readonly storage: StorageContext;
  private readonly eventRegistry: DurableEventRegistry;
  private readonly saveChanges?: () => void;

  constructor(options: StorageContext | ConversationRepositoryOptions) {
    if ("state" in options) {
      this.storage = options;
      this.eventRegistry = defaultDurableEventRegistry;
    } else {
      this.storage = options.storage;
      this.eventRegistry = options.eventRegistry ?? defaultDurableEventRegistry;
      this.saveChanges = options.save;
    }
  }

  appendEventInMemory(
    input: AppendEventInput,
    retain = true,
  ): SessionEventRecord {
    const prepared = this.eventRegistry.prepareWrite(
      input.type,
      input.payload ?? {},
      input.sessionId,
    );
    const event: SessionEventRecord = {
      id: input.id ?? randomUUID(),
      seq: this.storage.eventSequence.allocate(),
      type: input.type,
      schemaVersion: prepared.schemaVersion,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      payload: prepared.payload,
      createdAt: now(),
    };
    if (retain) {
      this.storage.state.events.push(event);
      this.storage.mutations.events.add(event.id);
    }
    return event;
  }

  appendEvent(input: AppendEventInput): SessionEventRecord {
    if (input.sessionId) assertSession(this.storage.state, input.sessionId);
    const event = this.appendEventInMemory(input);
    this.saveChanges?.();
    return clone(event);
  }

  createMessage(input: CreateMessageInput): SessionMessageRecord {
    const session = assertSession(this.storage.state, input.sessionId);
    const id = input.id ?? randomUUID();
    if (this.storage.state.messages[id])
      throw new Error(`Session message already exists: ${id}`);
    const timestamp = now();
    const row: SessionMessageRecord = {
      id,
      sessionId: input.sessionId,
      seq: maxSeq(this.storage.state.messages, input.sessionId) + 1,
      role: input.role,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inputId ? { inputId: input.inputId } : {}),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.storage.state.messages[id] = row;
    session.updatedAt = timestamp;
    this.storage.mutations.messages.add(id);
    this.storage.mutations.sessions.add(input.sessionId);
    this.appendEventInMemory({
      type: "session.message.created",
      sessionId: input.sessionId,
      payload: { message: row },
    });
    this.saveChanges?.();
    return clone(row);
  }

  upsertMessagePart(input: UpsertMessagePartInput): SessionMessagePartRecord {
    const session = assertSession(this.storage.state, input.sessionId);
    const message = assertMessage(this.storage.state, input.messageId);
    if (message.sessionId !== input.sessionId) {
      throw new Error(
        `Session message ${input.messageId} does not belong to session ${input.sessionId}`,
      );
    }
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const existing = this.storage.state.parts[id];
    const row: SessionMessagePartRecord = existing
      ? {
          ...existing,
          type: input.type,
          status: input.status ?? existing.status,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined
            ? { toolUseId: input.toolUseId }
            : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.mediaType !== undefined
            ? { mediaType: input.mediaType }
            : {}),
          ...(input.sizeBytes !== undefined
            ? { sizeBytes: input.sizeBytes }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.representationId !== undefined
            ? { representationId: input.representationId }
            : {}),
          ...(input.processor !== undefined
            ? { processor: input.processor }
            : {}),
          ...(input.transformationError !== undefined
            ? { transformationError: input.transformationError }
            : {}),
          metadata: input.metadata
            ? { ...existing.metadata, ...input.metadata }
            : existing.metadata,
          updatedAt: timestamp,
        }
      : {
          id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          seq: maxSeq(this.storage.state.parts, input.sessionId) + 1,
          type: input.type,
          status: input.status ?? "pending",
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined
            ? { toolUseId: input.toolUseId }
            : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.mediaType !== undefined
            ? { mediaType: input.mediaType }
            : {}),
          ...(input.sizeBytes !== undefined
            ? { sizeBytes: input.sizeBytes }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.representationId !== undefined
            ? { representationId: input.representationId }
            : {}),
          ...(input.processor !== undefined
            ? { processor: input.processor }
            : {}),
          ...(input.transformationError !== undefined
            ? { transformationError: input.transformationError }
            : {}),
          metadata: input.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    this.storage.state.parts[id] = row;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.storage.mutations.parts.add(id);
    this.storage.mutations.messages.add(message.id);
    this.storage.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.message.part.updated",
      sessionId: input.sessionId,
      payload: { part: clone(row) },
    });
    this.saveChanges?.();
    return clone(row);
  }

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
