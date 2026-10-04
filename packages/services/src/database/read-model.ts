import { eq } from "drizzle-orm";

import type { SessionDatabase } from "./session-database.js";
import {
  sessions, sessionInputs, sessionInputAttachments, sessionMessages,
  sessionMessageParts, sessionRuns, sessionRunAttempts, sessionTasks,
  permissionRequests, sessionEvents, sessionEventSequence,
} from "../session-runtime/schema.js";
import {
  normalizeSessionUserInputItems,
  sessionUserInputText,
  type PermissionRequestRecord,
  type SessionEventRecord,
  type SessionExecutionRecord,
  type SessionInputAttachmentRecord,
  type SessionInputRecord,
  type SessionMessagePartRecord,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionRunAttemptRecord,
  type SessionRunRecord,
  type SessionUserInputItem,
} from "@vykor/protocol";

import type { DurableEventRegistry } from "../session-runtime/event-registry.js";
import {
  decode,
  emptyState,
  type SessionState,
} from "../session-runtime/store-state.js";

export interface LoadedSessionReadModel {
  state: SessionState;
  reservedEventSeq: number;
}

export function loadSessionReadModel(
  database: SessionDatabase["orm"],
  eventRegistry: DurableEventRegistry,
): LoadedSessionReadModel {
  const state = emptyState();
  let reservedEventSeq = 0;
  for (const row of database.select().from(sessions).all()) {
    const session: SessionRecord = {
      id: row.id as string,
      ...(row.parentId ? { parentId: row.parentId as string } : {}),
      ...(row.projectId ? { projectId: row.projectId as string } : {}),
      cwd: row.cwd as string,
      ...(row.cwdRelative !== null
        ? { cwdRelative: row.cwdRelative as string }
        : {}),
      title: row.title as string,
      model: row.model as string,
      ...(row.agent ? { agent: row.agent as string } : {}),
      status: row.status as SessionRecord["status"],
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
      ...(row.archivedAt ? { archivedAt: row.archivedAt as number } : {}),
    };
    state.sessions[session.id] = session;
  }
  for (const row of database.select().from(sessionInputs).all()) {
    const input: SessionInputRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      seq: row.seq as number,
      delivery: row.delivery as SessionInputRecord["delivery"],
      ...hydrateInput(row),
      attachments: [],
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
    };
    state.inputs[input.id] = input;
  }
  for (const row of database.select().from(sessionInputAttachments).orderBy(sessionInputAttachments.inputId, sessionInputAttachments.seq).all()) {
    const reference: SessionInputAttachmentRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      inputId: row.inputId as string,
      assetId: row.assetId as string,
      seq: row.seq as number,
      intent: row.intent as SessionInputAttachmentRecord["intent"],
      displayName: row.displayName as string,
      mediaType: row.mediaType as string,
      sizeBytes: row.sizeBytes as number,
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
    };
    state.inputAttachments[reference.id] = reference;
    const input = state.inputs[reference.inputId];
    if (input) input.attachments.push(reference);
  }
  for (const row of database.select().from(sessionMessages).all()) {
    const message: SessionMessageRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      seq: row.seq as number,
      role: row.role as SessionMessageRecord["role"],
      ...(row.runId ? { runId: row.runId as string } : {}),
      ...(row.inputId ? { inputId: row.inputId as string } : {}),
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
    state.messages[message.id] = message;
  }
  for (const row of database.select().from(sessionMessageParts).all()) {
    const part: SessionMessagePartRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      messageId: row.messageId as string,
      seq: row.seq as number,
      type: row.type as SessionMessagePartRecord["type"],
      status: row.status as SessionMessagePartRecord["status"],
      ...(row.text !== null ? { text: row.text as string } : {}),
      ...(row.toolUseId ? { toolUseId: row.toolUseId as string } : {}),
      ...(row.toolName ? { toolName: row.toolName as string } : {}),
      ...(row.inputJson ? { input: decode(row.inputJson as string) } : {}),
      ...(row.outputJson
        ? { output: JSON.parse(row.outputJson as string) }
        : {}),
      ...(row.isError !== null ? { isError: Boolean(row.isError) } : {}),
      ...(row.assetId ? { assetId: row.assetId as string } : {}),
      ...(row.attachmentIntent
        ? {
            intent:
              row.attachmentIntent as SessionMessagePartRecord["intent"],
          }
        : {}),
      ...(row.displayName
        ? { displayName: row.displayName as string }
        : {}),
      ...(row.mediaType ? { mediaType: row.mediaType as string } : {}),
      ...(row.sizeBytes !== null
        ? { sizeBytes: row.sizeBytes as number }
        : {}),
      ...(row.transformationKind
        ? {
            kind: row.transformationKind as SessionMessagePartRecord["kind"],
          }
        : {}),
      ...(row.representationId
        ? { representationId: row.representationId as string }
        : {}),
      ...(row.processor ? { processor: row.processor as string } : {}),
      ...(row.transformationError
        ? { transformationError: row.transformationError as string }
        : {}),
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
    state.parts[part.id] = part;
  }
  for (const row of database.select().from(sessionRuns).all()) {
    const run: SessionRunRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      ...(row.inputId ? { inputId: row.inputId as string } : {}),
      status: row.status as SessionRunRecord["status"],
      ...(row.startedAt ? { startedAt: row.startedAt as number } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt as number } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
    state.runs[run.id] = run;
  }
  for (const row of database.select().from(sessionRunAttempts).all()) {
    const attempt: SessionRunAttemptRecord = {
      id: row.id as string,
      runId: row.runId as string,
      sequence: row.sequence as number,
      status: row.status as SessionRunAttemptRecord["status"],
      ...(row.provider ? { provider: row.provider as string } : {}),
      ...(row.model ? { model: row.model as string } : {}),
      ...(row.retryReason
        ? { retryReason: row.retryReason as string }
        : {}),
      ...(row.errorKind ? { errorKind: row.errorKind as string } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      ...(row.inputTokens !== null
        ? { inputTokens: row.inputTokens as number }
        : {}),
      ...(row.outputTokens !== null
        ? { outputTokens: row.outputTokens as number }
        : {}),
      ...(row.startedAt ? { startedAt: row.startedAt as number } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt as number } : {}),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
    state.attempts[attempt.id] = attempt;
  }
  for (const row of database.select().from(sessionTasks).all()) {
    const task: SessionExecutionRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      ...(row.requestNamespace
        ? { requestNamespace: row.requestNamespace as string }
        : {}),
      ...(row.requestId ? { requestId: row.requestId as string } : {}),
      ...(row.childSessionId
        ? { childSessionId: row.childSessionId as string }
        : {}),
      ...(row.runId ? { runId: row.runId as string } : {}),
      type: row.type as string,
      status: row.status as SessionExecutionRecord["status"],
      description: row.description as string,
      cwd: row.cwd as string,
      ...(row.output ? { output: row.output as string } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      metadata: decode(row.metadataJson as string),
      createdAt: row.createdAt as number,
      ...(row.startedAt ? { startedAt: row.startedAt as number } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt as number } : {}),
      updatedAt: row.updatedAt as number,
    };
    state.tasks[task.id] = task;
  }
  for (const row of database.select().from(permissionRequests).all()) {
    const request: PermissionRequestRecord = {
      id: row.id as string,
      sessionId: row.sessionId as string,
      ...(row.runId ? { runId: row.runId as string } : {}),
      toolName: row.toolName as string,
      payload: decode(row.payloadJson as string),
      status: row.status as PermissionRequestRecord["status"],
      ...(row.decision ? { decision: row.decision as string } : {}),
      ...(row.decidedByClientId
        ? { decidedByClientId: row.decidedByClientId as string }
        : {}),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
    state.permissions[request.id] = request;
  }
  for (const row of database.select().from(sessionEvents).orderBy(sessionEvents.seq).all()) {
    const schemaVersion = row.schemaVersion as number;
    const prepared = eventRegistry.prepareRead(
      row.type as string,
      schemaVersion,
      decode(row.payloadJson as string),
      row.sessionId ? (row.sessionId as string) : undefined,
    );
    const event: SessionEventRecord = {
      id: row.id as string,
      seq: row.seq as number,
      type: prepared.type,
      schemaVersion: prepared.schemaVersion,
      ...(row.sessionId ? { sessionId: row.sessionId as string } : {}),
      payload: prepared.payload,
      createdAt: row.createdAt as number,
    };
    state.events.push(event);
    state.nextEventSeq = Math.max(state.nextEventSeq, event.seq + 1);
  }
  const sequence = database.select().from(sessionEventSequence)
    .where(eq(sessionEventSequence.id, 1)).get();
  reservedEventSeq = sequence?.reservedThrough ?? 0;
  state.nextEventSeq = Math.max(
    state.nextEventSeq,
    reservedEventSeq + 1,
  );
  return { state, reservedEventSeq };
}

function hydrateInput(
  row: typeof sessionInputs.$inferSelect,
): Pick<SessionInputRecord, "items" | "content"> {
  if (typeof row.itemsJson !== "string") {
    throw new Error("invalid_session_input_items");
  }
  const items = normalizeSessionUserInputItems(
    decode(row.itemsJson) as unknown as SessionUserInputItem[],
  );
  return { items, content: sessionUserInputText(items) };
}
