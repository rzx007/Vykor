import type { RunResult } from "better-sqlite3";
import { eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteInsertBase, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { StorageContext } from "../database/storage-context.js";
import type { IncrementalOutput } from "../conversations/index.js";
import {
  sessions, sessionInputs, sessionInputAttachments, sessionMessages,
  sessionMessageParts, sessionRuns, sessionRunAttempts, sessionTasks,
  permissionRequests, sessionEvents,
} from "./schema.js";
import { encode, isDurableEvent } from "./store-state.js";

type PreparedInsert<T extends SQLiteTable> = ReturnType<SQLiteInsertBase<T, "sync", RunResult>["prepare"]>;

function namedPlaceholders<T extends Record<string, unknown>>(fields: T): { [K in keyof T]: SQL<T[K]> } {
  return Object.fromEntries(Object.keys(fields).map((name) => [name, sql`${sql.placeholder(name)}`])) as {
    [K in keyof T]: SQL<T[K]>;
  };
}

export function persistSessionChanges(storage: StorageContext, output: Pick<IncrementalOutput, "flushMessagePartDeltas">): void {
  const dirtyPartIds = storage.deltaCheckpoint.dirtyPartIds();
  if (dirtyPartIds.length > 0) output.flushMessagePartDeltas();

  const database = storage.database.orm;
  if (storage.mutations.deletedInputAttachments.size > 0) {
    const query = database.delete(sessionInputAttachments)
      .where(eq(sessionInputAttachments.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedInputAttachments) query.run({ id });
  }
  if (storage.mutations.deletedParts.size > 0) {
    const query = database.delete(sessionMessageParts)
      .where(eq(sessionMessageParts.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedParts) query.run({ id });
  }
  if (storage.mutations.deletedMessages.size > 0) {
    const query = database.delete(sessionMessages)
      .where(eq(sessionMessages.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedMessages) query.run({ id });
  }
  if (storage.mutations.deletedAttempts.size > 0) {
    const query = database.delete(sessionRunAttempts)
      .where(eq(sessionRunAttempts.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedAttempts) query.run({ id });
  }
  if (storage.mutations.deletedRuns.size > 0) {
    const query = database.delete(sessionRuns)
      .where(eq(sessionRuns.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedRuns) query.run({ id });
  }
  if (storage.mutations.deletedInputs.size > 0) {
    const query = database.delete(sessionInputs)
      .where(eq(sessionInputs.id, sql.placeholder("id"))).prepare();
    for (const id of storage.mutations.deletedInputs) query.run({ id });
  }

  // Reuse each Drizzle query within this flush; the outer transaction still owns commit/rollback.
  let upsertSession: PreparedInsert<typeof sessions> | undefined;
  for (const id of storage.mutations.sessions) {
    const value = storage.state.sessions[id];
    if (!value) continue;
    const fields = {
      parentId: value.parentId ?? null,
      cwd: value.cwd,
      projectId: value.projectId ?? null,
      cwdRelative: value.cwdRelative ?? null,
      title: value.title,
      model: value.model,
      agent: value.agent ?? null,
      status: value.status,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      archivedAt: value.archivedAt ?? null,
    } satisfies Omit<typeof sessions.$inferInsert, "id">;
    upsertSession ??= database.insert(sessions).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessions.id, set: namedPlaceholders(fields) }).prepare();
    upsertSession.run({ id: value.id, ...fields });
  }

  let upsertInput: PreparedInsert<typeof sessionInputs> | undefined;
  for (const id of storage.mutations.inputs) {
    const value = storage.state.inputs[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      seq: value.seq,
      delivery: value.delivery,
      content: value.content,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      itemsJson: encode(value.items),
    } satisfies Omit<typeof sessionInputs.$inferInsert, "id">;
    upsertInput ??= database.insert(sessionInputs).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionInputs.id, set: namedPlaceholders(fields) }).prepare();
    upsertInput.run({ id: value.id, ...fields });
  }

  let upsertInputAttachment: PreparedInsert<typeof sessionInputAttachments> | undefined;
  for (const id of storage.mutations.inputAttachments) {
    const value = storage.state.inputAttachments[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      inputId: value.inputId,
      assetId: value.assetId,
      seq: value.seq,
      intent: value.intent,
      displayName: value.displayName,
      mediaType: value.mediaType,
      sizeBytes: value.sizeBytes,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
    } satisfies Omit<typeof sessionInputAttachments.$inferInsert, "id">;
    upsertInputAttachment ??= database.insert(sessionInputAttachments).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionInputAttachments.id, set: namedPlaceholders(fields) }).prepare();
    upsertInputAttachment.run({ id: value.id, ...fields });
  }

  let upsertMessage: PreparedInsert<typeof sessionMessages> | undefined;
  for (const id of storage.mutations.messages) {
    const value = storage.state.messages[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      seq: value.seq,
      role: value.role,
      runId: value.runId ?? null,
      inputId: value.inputId ?? null,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof sessionMessages.$inferInsert, "id">;
    upsertMessage ??= database.insert(sessionMessages).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionMessages.id, set: namedPlaceholders(fields) }).prepare();
    upsertMessage.run({ id: value.id, ...fields });
  }

  let upsertPart: PreparedInsert<typeof sessionMessageParts> | undefined;
  for (const id of storage.mutations.parts) {
    const value = storage.state.parts[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      messageId: value.messageId,
      seq: value.seq,
      type: value.type,
      status: value.status,
      text: value.text ?? null,
      toolUseId: value.toolUseId ?? null,
      toolName: value.toolName ?? null,
      inputJson: value.input === undefined ? null : encode(value.input),
      outputJson: value.output === undefined ? null : JSON.stringify(value.output),
      isError: value.isError === undefined ? null : Number(value.isError),
      assetId: value.assetId ?? null,
      attachmentIntent: value.intent ?? null,
      displayName: value.displayName ?? null,
      mediaType: value.mediaType ?? null,
      sizeBytes: value.sizeBytes ?? null,
      transformationKind: value.kind ?? null,
      representationId: value.representationId ?? null,
      processor: value.processor ?? null,
      transformationError: value.transformationError ?? null,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof sessionMessageParts.$inferInsert, "id">;
    upsertPart ??= database.insert(sessionMessageParts).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionMessageParts.id, set: namedPlaceholders(fields) }).prepare();
    upsertPart.run({ id: value.id, ...fields });
  }

  let upsertRun: PreparedInsert<typeof sessionRuns> | undefined;
  for (const id of storage.mutations.runs) {
    const value = storage.state.runs[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      inputId: value.inputId ?? null,
      status: value.status,
      startedAt: value.startedAt ?? null,
      finishedAt: value.finishedAt ?? null,
      error: value.error ?? null,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof sessionRuns.$inferInsert, "id">;
    upsertRun ??= database.insert(sessionRuns).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionRuns.id, set: namedPlaceholders(fields) }).prepare();
    upsertRun.run({ id: value.id, ...fields });
  }

  let upsertAttempt: PreparedInsert<typeof sessionRunAttempts> | undefined;
  for (const id of storage.mutations.attempts) {
    const value = storage.state.attempts[id];
    if (!value) continue;
    const fields = {
      runId: value.runId,
      sequence: value.sequence,
      status: value.status,
      provider: value.provider ?? null,
      model: value.model ?? null,
      retryReason: value.retryReason ?? null,
      errorKind: value.errorKind ?? null,
      error: value.error ?? null,
      inputTokens: value.inputTokens ?? null,
      outputTokens: value.outputTokens ?? null,
      startedAt: value.startedAt ?? null,
      finishedAt: value.finishedAt ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof sessionRunAttempts.$inferInsert, "id">;
    upsertAttempt ??= database.insert(sessionRunAttempts).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionRunAttempts.id, set: namedPlaceholders(fields) }).prepare();
    upsertAttempt.run({ id: value.id, ...fields });
  }

  let upsertTask: PreparedInsert<typeof sessionTasks> | undefined;
  for (const id of storage.mutations.tasks) {
    const value = storage.state.tasks[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      requestNamespace: value.requestNamespace ?? null,
      requestId: value.requestId ?? null,
      childSessionId: value.childSessionId ?? null,
      runId: value.runId ?? null,
      type: value.type,
      status: value.status,
      description: value.description,
      cwd: value.cwd,
      output: value.output ?? null,
      error: value.error ?? null,
      metadataJson: encode(value.metadata),
      createdAt: value.createdAt,
      startedAt: value.startedAt ?? null,
      finishedAt: value.finishedAt ?? null,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof sessionTasks.$inferInsert, "id">;
    upsertTask ??= database.insert(sessionTasks).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: sessionTasks.id, set: namedPlaceholders(fields) }).prepare();
    upsertTask.run({ id: value.id, ...fields });
  }

  let upsertPermission: PreparedInsert<typeof permissionRequests> | undefined;
  for (const id of storage.mutations.permissions) {
    const value = storage.state.permissions[id];
    if (!value) continue;
    const fields = {
      sessionId: value.sessionId,
      runId: value.runId ?? null,
      toolName: value.toolName,
      payloadJson: encode(value.payload),
      status: value.status,
      decision: value.decision ?? null,
      decidedByClientId: value.decidedByClientId ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } satisfies Omit<typeof permissionRequests.$inferInsert, "id">;
    upsertPermission ??= database.insert(permissionRequests).values(namedPlaceholders({ id: value.id, ...fields }))
      .onConflictDoUpdate({ target: permissionRequests.id, set: namedPlaceholders(fields) }).prepare();
    upsertPermission.run({ id: value.id, ...fields });
  }

  let insertEvent: PreparedInsert<typeof sessionEvents> | undefined;
  for (const value of storage.state.events) {
    if (!storage.mutations.events.has(value.id) || !isDurableEvent(value)) continue;
    const fields = {
      id: value.id,
      seq: value.seq,
      type: value.type,
      sessionId: value.sessionId ?? null,
      payloadJson: encode(value.payload),
      createdAt: value.createdAt,
      schemaVersion: value.schemaVersion,
    } satisfies typeof sessionEvents.$inferInsert;
    insertEvent ??= database.insert(sessionEvents).values(namedPlaceholders(fields)).prepare();
    insertEvent.run(fields);
  }
}
