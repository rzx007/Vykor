import type { StorageContext } from "../database/storage-context.js";
import type { IncrementalOutput } from "../conversations/index.js";
import { encode, isDurableEvent } from "./store-state.js";

export function persistSessionChanges(storage: StorageContext, output: Pick<IncrementalOutput, "flushMessagePartDeltas">): void {
  const dirtyPartIds = storage.deltaCheckpoint.dirtyPartIds();
  if (dirtyPartIds.length > 0) output.flushMessagePartDeltas();

  const deleteInputAttachment = storage.database.connection.prepare(
    "DELETE FROM session_input_attachment WHERE id = ?",
  );
  for (const id of storage.mutations.deletedInputAttachments) {
    deleteInputAttachment.run(id);
  }
  const deletePart = storage.database.connection.prepare(
    "DELETE FROM session_message_part WHERE id = ?",
  );
  for (const id of storage.mutations.deletedParts) deletePart.run(id);
  const deleteMessage = storage.database.connection.prepare(
    "DELETE FROM session_message WHERE id = ?",
  );
  for (const id of storage.mutations.deletedMessages) deleteMessage.run(id);
  const deleteAttempt = storage.database.connection.prepare(
    "DELETE FROM session_run_attempt WHERE id = ?",
  );
  for (const id of storage.mutations.deletedAttempts) deleteAttempt.run(id);
  const deleteRun = storage.database.connection.prepare(
    "DELETE FROM session_run WHERE id = ?",
  );
  for (const id of storage.mutations.deletedRuns) deleteRun.run(id);
  const deleteInput = storage.database.connection.prepare(
    "DELETE FROM session_input WHERE id = ?",
  );
  for (const id of storage.mutations.deletedInputs) deleteInput.run(id);

  const upsertSession = storage.database.connection.prepare(`
    INSERT INTO session (
      id, parent_id, cwd, title, model, agent, status, metadata_json,
      created_at, updated_at, archived_at, project_id, cwd_relative
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, cwd=excluded.cwd,
      project_id=excluded.project_id, cwd_relative=excluded.cwd_relative,
      title=excluded.title, model=excluded.model, agent=excluded.agent, status=excluded.status,
      metadata_json=excluded.metadata_json, created_at=excluded.created_at,
      updated_at=excluded.updated_at, archived_at=excluded.archived_at
  `);
  for (const id of storage.mutations.sessions) {
    const value = storage.state.sessions[id];
    if (value)
      upsertSession.run(
        value.id,
        value.parentId ?? null,
        value.cwd,
        value.title,
        value.model,
        value.agent ?? null,
        value.status,
        encode(value.metadata),
        value.createdAt,
        value.updatedAt,
        value.archivedAt ?? null,
        value.projectId ?? null,
        value.cwdRelative ?? null,
      );
  }

  const upsertInput = storage.database.connection.prepare(`
    INSERT INTO session_input (
      id, session_id, seq, delivery, content, metadata_json, created_at,
      items_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
      delivery=excluded.delivery, content=excluded.content, metadata_json=excluded.metadata_json,
      created_at=excluded.created_at, items_json=excluded.items_json
  `);
  for (const id of storage.mutations.inputs) {
    const value = storage.state.inputs[id];
    if (value)
      upsertInput.run(
        value.id,
        value.sessionId,
        value.seq,
        value.delivery,
        value.content,
        encode(value.metadata),
        value.createdAt,
        encode(value.items),
      );
  }

  const upsertInputAttachment = storage.database.connection.prepare(`
    INSERT INTO session_input_attachment (
      id, session_id, input_id, asset_id, seq, intent, display_name,
      media_type, size_bytes, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
      input_id=excluded.input_id, asset_id=excluded.asset_id, seq=excluded.seq,
      intent=excluded.intent, display_name=excluded.display_name,
      media_type=excluded.media_type, size_bytes=excluded.size_bytes,
      metadata_json=excluded.metadata_json, created_at=excluded.created_at
  `);
  for (const id of storage.mutations.inputAttachments) {
    const value = storage.state.inputAttachments[id];
    if (value) {
      upsertInputAttachment.run(
        value.id,
        value.sessionId,
        value.inputId,
        value.assetId,
        value.seq,
        value.intent,
        value.displayName,
        value.mediaType,
        value.sizeBytes,
        encode(value.metadata),
        value.createdAt,
      );
    }
  }

  const upsertMessage = storage.database.connection.prepare(`
    INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
      role=excluded.role, run_id=excluded.run_id, input_id=excluded.input_id,
      metadata_json=excluded.metadata_json, created_at=excluded.created_at, updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.messages) {
    const value = storage.state.messages[id];
    if (value)
      upsertMessage.run(
        value.id,
        value.sessionId,
        value.seq,
        value.role,
        value.runId ?? null,
        value.inputId ?? null,
        encode(value.metadata),
        value.createdAt,
        value.updatedAt,
      );
  }

  const upsertPart = storage.database.connection.prepare(`
    INSERT INTO session_message_part (
      id, session_id, message_id, seq, type, status, text, tool_use_id, tool_name,
      input_json, output_json, is_error, asset_id, attachment_intent, display_name,
      media_type, size_bytes, transformation_kind, representation_id, processor,
      transformation_error, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id,
      seq=excluded.seq, type=excluded.type, status=excluded.status, text=excluded.text,
      tool_use_id=excluded.tool_use_id, tool_name=excluded.tool_name, input_json=excluded.input_json,
      output_json=excluded.output_json, is_error=excluded.is_error, asset_id=excluded.asset_id,
      attachment_intent=excluded.attachment_intent, display_name=excluded.display_name,
      media_type=excluded.media_type, size_bytes=excluded.size_bytes,
      transformation_kind=excluded.transformation_kind, representation_id=excluded.representation_id,
      processor=excluded.processor, transformation_error=excluded.transformation_error,
      metadata_json=excluded.metadata_json,
      created_at=excluded.created_at, updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.parts) {
    const value = storage.state.parts[id];
    if (value)
      upsertPart.run(
        value.id,
        value.sessionId,
        value.messageId,
        value.seq,
        value.type,
        value.status,
        value.text ?? null,
        value.toolUseId ?? null,
        value.toolName ?? null,
        value.input === undefined ? null : encode(value.input),
        value.output === undefined ? null : JSON.stringify(value.output),
        value.isError === undefined ? null : Number(value.isError),
        value.assetId ?? null,
        value.intent ?? null,
        value.displayName ?? null,
        value.mediaType ?? null,
        value.sizeBytes ?? null,
        value.kind ?? null,
        value.representationId ?? null,
        value.processor ?? null,
        value.transformationError ?? null,
        encode(value.metadata),
        value.createdAt,
        value.updatedAt,
      );
  }

  const upsertRun = storage.database.connection.prepare(`
    INSERT INTO session_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, input_id=excluded.input_id,
      status=excluded.status, started_at=excluded.started_at, finished_at=excluded.finished_at,
      error=excluded.error, metadata_json=excluded.metadata_json, created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.runs) {
    const value = storage.state.runs[id];
    if (value)
      upsertRun.run(
        value.id,
        value.sessionId,
        value.inputId ?? null,
        value.status,
        value.startedAt ?? null,
        value.finishedAt ?? null,
        value.error ?? null,
        encode(value.metadata),
        value.createdAt,
        value.updatedAt,
      );
  }

  const upsertAttempt = storage.database.connection.prepare(`
    INSERT INTO session_run_attempt VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, sequence=excluded.sequence,
      status=excluded.status, provider=excluded.provider, model=excluded.model,
      retry_reason=excluded.retry_reason, error_kind=excluded.error_kind, error=excluded.error,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      started_at=excluded.started_at, finished_at=excluded.finished_at,
      created_at=excluded.created_at, updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.attempts) {
    const value = storage.state.attempts[id];
    if (value)
      upsertAttempt.run(
        value.id,
        value.runId,
        value.sequence,
        value.status,
        value.provider ?? null,
        value.model ?? null,
        value.retryReason ?? null,
        value.errorKind ?? null,
        value.error ?? null,
        value.inputTokens ?? null,
        value.outputTokens ?? null,
        value.startedAt ?? null,
        value.finishedAt ?? null,
        value.createdAt,
        value.updatedAt,
      );
  }

  const upsertTask = storage.database.connection.prepare(`
    INSERT INTO session_task (
      id, session_id, request_namespace, request_id, child_session_id, run_id, type,
      status, description, cwd, output, error, metadata_json, created_at, started_at,
      finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
      request_namespace=excluded.request_namespace, request_id=excluded.request_id,
      child_session_id=excluded.child_session_id, run_id=excluded.run_id, type=excluded.type,
      status=excluded.status, description=excluded.description, cwd=excluded.cwd,
      output=excluded.output, error=excluded.error, metadata_json=excluded.metadata_json,
      created_at=excluded.created_at, started_at=excluded.started_at,
      finished_at=excluded.finished_at, updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.tasks) {
    const value = storage.state.tasks[id];
    if (value)
      upsertTask.run(
        value.id,
        value.sessionId,
        value.requestNamespace ?? null,
        value.requestId ?? null,
        value.childSessionId ?? null,
        value.runId ?? null,
        value.type,
        value.status,
        value.description,
        value.cwd,
        value.output ?? null,
        value.error ?? null,
        encode(value.metadata),
        value.createdAt,
        value.startedAt ?? null,
        value.finishedAt ?? null,
        value.updatedAt,
      );
  }

  const upsertPermission = storage.database.connection.prepare(`
    INSERT INTO permission_request VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, run_id=excluded.run_id,
      tool_name=excluded.tool_name, payload_json=excluded.payload_json, status=excluded.status,
      decision=excluded.decision, decided_by_client_id=excluded.decided_by_client_id,
      created_at=excluded.created_at, updated_at=excluded.updated_at
  `);
  for (const id of storage.mutations.permissions) {
    const value = storage.state.permissions[id];
    if (value)
      upsertPermission.run(
        value.id,
        value.sessionId,
        value.runId ?? null,
        value.toolName,
        encode(value.payload),
        value.status,
        value.decision ?? null,
        value.decidedByClientId ?? null,
        value.createdAt,
        value.updatedAt,
      );
  }

  const insertEvent = storage.database.connection.prepare(`
    INSERT INTO session_event
      (id, seq, type, session_id, payload_json, created_at, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of storage.state.events) {
    if (!storage.mutations.events.has(value.id) || !isDurableEvent(value))
      continue;
    insertEvent.run(
      value.id,
      value.seq,
      value.type,
      value.sessionId ?? null,
      encode(value.payload),
      value.createdAt,
      value.schemaVersion,
    );
  }
}
