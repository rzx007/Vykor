import type Database from "better-sqlite3";
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
} from "@openharness/protocol";

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
  database: Database.Database,
  eventRegistry: DurableEventRegistry,
): LoadedSessionReadModel {
  const state = emptyState();
  let reservedEventSeq = 0;
  for (const row of database
    .prepare("SELECT * FROM session")
    .all() as Array<Record<string, unknown>>) {
    const session: SessionRecord = {
      id: row.id as string,
      ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
      ...(row.project_id ? { projectId: row.project_id as string } : {}),
      cwd: row.cwd as string,
      ...(row.cwd_relative !== null
        ? { cwdRelative: row.cwd_relative as string }
        : {}),
      title: row.title as string,
      model: row.model as string,
      ...(row.agent ? { agent: row.agent as string } : {}),
      status: row.status as SessionRecord["status"],
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}),
    };
    state.sessions[session.id] = session;
  }
  for (const row of database
    .prepare("SELECT * FROM session_input")
    .all() as Array<Record<string, unknown>>) {
    const input: SessionInputRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      seq: row.seq as number,
      delivery: row.delivery as SessionInputRecord["delivery"],
      ...hydrateInput(row),
      attachments: [],
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
    };
    state.inputs[input.id] = input;
  }
  for (const row of database
    .prepare("SELECT * FROM session_input_attachment ORDER BY input_id, seq")
    .all() as Array<Record<string, unknown>>) {
    const reference: SessionInputAttachmentRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      inputId: row.input_id as string,
      assetId: row.asset_id as string,
      seq: row.seq as number,
      intent: row.intent as SessionInputAttachmentRecord["intent"],
      displayName: row.display_name as string,
      mediaType: row.media_type as string,
      sizeBytes: row.size_bytes as number,
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
    };
    state.inputAttachments[reference.id] = reference;
    const input = state.inputs[reference.inputId];
    if (input) input.attachments.push(reference);
  }
  for (const row of database
    .prepare("SELECT * FROM session_message")
    .all() as Array<Record<string, unknown>>) {
    const message: SessionMessageRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      seq: row.seq as number,
      role: row.role as SessionMessageRecord["role"],
      ...(row.run_id ? { runId: row.run_id as string } : {}),
      ...(row.input_id ? { inputId: row.input_id as string } : {}),
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
    state.messages[message.id] = message;
  }
  for (const row of database
    .prepare("SELECT * FROM session_message_part")
    .all() as Array<Record<string, unknown>>) {
    const part: SessionMessagePartRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      messageId: row.message_id as string,
      seq: row.seq as number,
      type: row.type as SessionMessagePartRecord["type"],
      status: row.status as SessionMessagePartRecord["status"],
      ...(row.text !== null ? { text: row.text as string } : {}),
      ...(row.tool_use_id ? { toolUseId: row.tool_use_id as string } : {}),
      ...(row.tool_name ? { toolName: row.tool_name as string } : {}),
      ...(row.input_json ? { input: decode(row.input_json as string) } : {}),
      ...(row.output_json
        ? { output: JSON.parse(row.output_json as string) }
        : {}),
      ...(row.is_error !== null ? { isError: Boolean(row.is_error) } : {}),
      ...(row.asset_id ? { assetId: row.asset_id as string } : {}),
      ...(row.attachment_intent
        ? {
            intent:
              row.attachment_intent as SessionMessagePartRecord["intent"],
          }
        : {}),
      ...(row.display_name
        ? { displayName: row.display_name as string }
        : {}),
      ...(row.media_type ? { mediaType: row.media_type as string } : {}),
      ...(row.size_bytes !== null
        ? { sizeBytes: row.size_bytes as number }
        : {}),
      ...(row.transformation_kind
        ? {
            kind: row.transformation_kind as SessionMessagePartRecord["kind"],
          }
        : {}),
      ...(row.representation_id
        ? { representationId: row.representation_id as string }
        : {}),
      ...(row.processor ? { processor: row.processor as string } : {}),
      ...(row.transformation_error
        ? { transformationError: row.transformation_error as string }
        : {}),
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
    state.parts[part.id] = part;
  }
  for (const row of database
    .prepare("SELECT * FROM session_run")
    .all() as Array<Record<string, unknown>>) {
    const run: SessionRunRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      ...(row.input_id ? { inputId: row.input_id as string } : {}),
      status: row.status as SessionRunRecord["status"],
      ...(row.started_at ? { startedAt: row.started_at as number } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
    state.runs[run.id] = run;
  }
  for (const row of database
    .prepare("SELECT * FROM session_run_attempt")
    .all() as Array<Record<string, unknown>>) {
    const attempt: SessionRunAttemptRecord = {
      id: row.id as string,
      runId: row.run_id as string,
      sequence: row.sequence as number,
      status: row.status as SessionRunAttemptRecord["status"],
      ...(row.provider ? { provider: row.provider as string } : {}),
      ...(row.model ? { model: row.model as string } : {}),
      ...(row.retry_reason
        ? { retryReason: row.retry_reason as string }
        : {}),
      ...(row.error_kind ? { errorKind: row.error_kind as string } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      ...(row.input_tokens !== null
        ? { inputTokens: row.input_tokens as number }
        : {}),
      ...(row.output_tokens !== null
        ? { outputTokens: row.output_tokens as number }
        : {}),
      ...(row.started_at ? { startedAt: row.started_at as number } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
    state.attempts[attempt.id] = attempt;
  }
  for (const row of database
    .prepare("SELECT * FROM session_task")
    .all() as Array<Record<string, unknown>>) {
    const task: SessionExecutionRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      ...(row.request_namespace
        ? { requestNamespace: row.request_namespace as string }
        : {}),
      ...(row.request_id ? { requestId: row.request_id as string } : {}),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as string }
        : {}),
      ...(row.run_id ? { runId: row.run_id as string } : {}),
      type: row.type as string,
      status: row.status as SessionExecutionRecord["status"],
      description: row.description as string,
      cwd: row.cwd as string,
      ...(row.output ? { output: row.output as string } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      metadata: decode(row.metadata_json as string),
      createdAt: row.created_at as number,
      ...(row.started_at ? { startedAt: row.started_at as number } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
      updatedAt: row.updated_at as number,
    };
    state.tasks[task.id] = task;
  }
  for (const row of database
    .prepare("SELECT * FROM permission_request")
    .all() as Array<Record<string, unknown>>) {
    const request: PermissionRequestRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      ...(row.run_id ? { runId: row.run_id as string } : {}),
      toolName: row.tool_name as string,
      payload: decode(row.payload_json as string),
      status: row.status as PermissionRequestRecord["status"],
      ...(row.decision ? { decision: row.decision as string } : {}),
      ...(row.decided_by_client_id
        ? { decidedByClientId: row.decided_by_client_id as string }
        : {}),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
    state.permissions[request.id] = request;
  }
  for (const row of database
    .prepare("SELECT * FROM session_event ORDER BY seq")
    .all() as Array<Record<string, unknown>>) {
    const schemaVersion = row.schema_version as number;
    const prepared = eventRegistry.prepareRead(
      row.type as string,
      schemaVersion,
      decode(row.payload_json as string),
      row.session_id ? (row.session_id as string) : undefined,
    );
    const event: SessionEventRecord = {
      id: row.id as string,
      seq: row.seq as number,
      type: prepared.type,
      schemaVersion: prepared.schemaVersion,
      ...(row.session_id ? { sessionId: row.session_id as string } : {}),
      payload: prepared.payload,
      createdAt: row.created_at as number,
    };
    state.events.push(event);
    state.nextEventSeq = Math.max(state.nextEventSeq, event.seq + 1);
  }
  const sequence = database
    .prepare(
      "SELECT reserved_through FROM session_event_sequence WHERE id = 1",
    )
    .get() as { reserved_through?: number } | undefined;
  reservedEventSeq = sequence?.reserved_through ?? 0;
  state.nextEventSeq = Math.max(
    state.nextEventSeq,
    reservedEventSeq + 1,
  );
  return { state, reservedEventSeq };
}

function hydrateInput(
  row: Record<string, unknown>,
): Pick<SessionInputRecord, "items" | "content"> {
  if (row.items_json === null || row.items_json === undefined) {
    throw new LegacySessionInputError();
  }
  if (typeof row.items_json !== "string") {
    throw new Error("invalid_session_input_items");
  }
  const items = normalizeSessionUserInputItems(
    decode(row.items_json) as unknown as SessionUserInputItem[],
  );
  return { items, content: sessionUserInputText(items) };
}

class LegacySessionInputError extends Error {
  readonly code = "legacy_session_input_unsupported";

  constructor() {
    super(
      "legacy_session_input_unsupported: clear legacy Session data before reopening it",
    );
  }
}
