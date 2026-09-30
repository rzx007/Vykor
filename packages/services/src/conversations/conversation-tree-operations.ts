import type { CreateSessionInput, SessionInputRecord, SessionRecord } from "@vykor/protocol";
import type { StorageContext } from "../database/storage-context.js";
import type { SessionRepository } from "../sessions/session-repository.js";
import { assertSession, clone } from "../session-runtime/store-state.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { AdmitPromptTransactionInput, ConversationTransactionTestHooks } from "./conversation-transactions.js";

interface TreeContext {
  storage: StorageContext;
  conversations: ConversationRepository;
  testHooks?: ConversationTransactionTestHooks;
}

interface ForkContext extends TreeContext {
  requireSessions(): SessionRepository;
  admitPrompt(input: AdmitPromptTransactionInput): SessionInputRecord;
}

export function forkSessionWithHistory(input: {
  sourceSessionId: string;
  beforeMessageId?: string;
  afterMessageId?: string;
  session: CreateSessionInput;
}, context: ForkContext): SessionRecord {
  return context.storage.atomic(() => {
    const source = assertSession(context.storage.state, input.sourceSessionId);
    const sourceMessages = context.conversations.listMessages(source.id);
    const beforeMessage = input.beforeMessageId
      ? sourceMessages.find(({ id }) => id === input.beforeMessageId)
      : undefined;
    const afterMessage = input.afterMessageId
      ? sourceMessages.find(({ id }) => id === input.afterMessageId)
      : undefined;
    if ((input.beforeMessageId && !beforeMessage) || (input.afterMessageId && !afterMessage)) {
      throw new Error("Fork point not found");
    }
    const beforeSeq = beforeMessage?.seq ?? Number.POSITIVE_INFINITY;
    const afterSeq = afterMessage?.seq ?? Number.POSITIVE_INFINITY;
    const copiedMessages = sourceMessages.filter(
      ({ seq }) => seq < beforeSeq && seq <= afterSeq,
    );
    const sourceParts = context.conversations.listMessageParts(source.id);
    const fork = context.requireSessions().create({ ...input.session, parentId: source.id });
    context.testHooks?.afterForkSessionCreated?.();

    const inputIdMap = new Map<string, string>();
    const attachmentReferenceIdMap = new Map<string, string>();
    for (const message of copiedMessages) {
      if (!message.inputId || inputIdMap.has(message.inputId)) continue;
      const sourceInput = context.storage.state.inputs[message.inputId];
      if (!sourceInput) continue;
      const copiedInput = context.admitPrompt({
        sessionId: fork.id,
        delivery: sourceInput.delivery,
        items: sourceInput.items,
        attachments: sourceInput.attachments.map((attachment) => ({
          assetId: attachment.assetId,
          intent: attachment.intent,
          displayName: attachment.displayName,
        })),
        metadata: sourceInput.metadata,
      });
      inputIdMap.set(sourceInput.id, copiedInput.id);
      sourceInput.attachments.forEach((attachment, index) => {
        const copiedReference = copiedInput.attachments[index];
        if (copiedReference) attachmentReferenceIdMap.set(attachment.id, copiedReference.id);
      });
    }
    context.testHooks?.afterForkInputsCopied?.();

    const messageIdMap = new Map<string, string>();
    for (const message of copiedMessages) {
      const copiedMessage = context.conversations.createMessage({
        sessionId: fork.id,
        role: message.role,
        ...(message.inputId && inputIdMap.has(message.inputId)
          ? { inputId: inputIdMap.get(message.inputId)! }
          : {}),
        metadata: message.metadata,
      });
      messageIdMap.set(message.id, copiedMessage.id);
    }
    context.testHooks?.afterForkMessagesCopied?.();

    for (const part of sourceParts) {
      const messageId = messageIdMap.get(part.messageId);
      if (!messageId) continue;
      const sourceReferenceId = typeof part.metadata.inputAttachmentId === "string"
        ? part.metadata.inputAttachmentId
        : undefined;
      context.conversations.upsertMessagePart({
        sessionId: fork.id,
        messageId,
        type: part.type,
        status: part.status,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.toolUseId !== undefined ? { toolUseId: part.toolUseId } : {}),
        ...(part.toolName !== undefined ? { toolName: part.toolName } : {}),
        ...(part.input !== undefined ? { input: part.input } : {}),
        ...(part.output !== undefined ? { output: part.output } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
        ...(part.assetId !== undefined ? { assetId: part.assetId } : {}),
        ...(part.intent !== undefined ? { intent: part.intent } : {}),
        ...(part.displayName !== undefined ? { displayName: part.displayName } : {}),
        ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
        ...(part.sizeBytes !== undefined ? { sizeBytes: part.sizeBytes } : {}),
        ...(part.kind !== undefined ? { kind: part.kind } : {}),
        ...(part.representationId !== undefined ? { representationId: part.representationId } : {}),
        ...(part.processor !== undefined ? { processor: part.processor } : {}),
        ...(part.transformationError !== undefined ? { transformationError: part.transformationError } : {}),
        metadata: sourceReferenceId && attachmentReferenceIdMap.has(sourceReferenceId)
          ? { ...part.metadata, inputAttachmentId: attachmentReferenceIdMap.get(sourceReferenceId) }
          : part.metadata,
      });
    }
    context.testHooks?.afterForkPartsCopied?.();
    return clone(assertSession(context.storage.state, fork.id));
  });
}

export function deleteSessionTree(sessionId: string, context: TreeContext): string[] {
  if (context.storage.coordinator?.inTransaction) {
    throw new Error("deleteSessionTree cannot be called inside a store transaction");
  }
  assertSession(context.storage.state, sessionId);
  const sessionIds = collectSessionTreeIds(context.storage, sessionId);
  const sessionIdSet = new Set(sessionIds);
  const runIds = new Set(
    Object.values(context.storage.state.runs)
      .filter((run) => sessionIdSet.has(run.sessionId))
      .map(({ id }) => id),
  );

  return context.storage.atomic(() => {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const database = context.storage.database.connection;
    const timestamp = Date.now();
    database.prepare(`UPDATE scheduled_run SET session_id = NULL, updated_at = ? WHERE session_id IN (${placeholders})`).run(timestamp, ...sessionIds);
    database.prepare(`UPDATE scheduled_task SET status = CASE WHEN destination = 'chat' THEN 'paused' ELSE status END, next_run_at = CASE WHEN destination = 'chat' THEN NULL ELSE next_run_at END, session_id = NULL, updated_at = ? WHERE session_id IN (${placeholders})`).run(timestamp, ...sessionIds);
    database.prepare(`UPDATE scheduled_task SET created_from_session_id = NULL, updated_at = ? WHERE created_from_session_id IN (${placeholders})`).run(timestamp, ...sessionIds);
    database.prepare(`DELETE FROM permission_request WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_task WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_run_attempt WHERE run_id IN (SELECT id FROM session_run WHERE session_id IN (${placeholders}))`).run(...sessionIds);
    database.prepare(`DELETE FROM session_run WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_message_part WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_message WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_input WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session_event WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM session WHERE id IN (${placeholders})`).run(...sessionIds);

    for (const id of sessionIds) {
      delete context.storage.state.sessions[id];
      context.storage.mutations.sessions.delete(id);
    }
    context.testHooks?.duringDeleteMemory?.();
    for (const [id, row] of Object.entries(context.storage.state.inputs)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.inputs[id];
      context.storage.mutations.inputs.delete(id);
      context.storage.mutations.deletedInputs.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.inputAttachments)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.inputAttachments[id];
      context.storage.mutations.inputAttachments.delete(id);
      context.storage.mutations.deletedInputAttachments.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.messages)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.messages[id];
      context.storage.mutations.messages.delete(id);
      context.storage.mutations.deletedMessages.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.parts)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.parts[id];
      context.storage.mutations.parts.delete(id);
      context.storage.mutations.deletedParts.delete(id);
      context.storage.deltaCheckpoint.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.runs)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.runs[id];
      context.storage.mutations.runs.delete(id);
      context.storage.mutations.deletedRuns.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.attempts)) {
      if (!runIds.has(row.runId)) continue;
      delete context.storage.state.attempts[id];
      context.storage.mutations.attempts.delete(id);
      context.storage.mutations.deletedAttempts.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.tasks)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.tasks[id];
      context.storage.mutations.tasks.delete(id);
    }
    for (const [id, row] of Object.entries(context.storage.state.permissions)) {
      if (!sessionIdSet.has(row.sessionId)) continue;
      delete context.storage.state.permissions[id];
      context.storage.mutations.permissions.delete(id);
    }
    const removedEventIds = new Set(
      context.storage.state.events
        .filter((event) => event.sessionId && sessionIdSet.has(event.sessionId))
        .map(({ id }) => id),
    );
    context.storage.state.events = context.storage.state.events.filter(
      (event) => !event.sessionId || !sessionIdSet.has(event.sessionId),
    );
    for (const id of removedEventIds) context.storage.mutations.events.delete(id);
    context.conversations.appendEvent({ type: "session.deleted", payload: { sessionIds } });
    context.testHooks?.afterDeleteMemory?.();
    return sessionIds;
  });
}

function collectSessionTreeIds(storage: StorageContext, sessionId: string): string[] {
  const result: string[] = [];
  const visit = (id: string): void => {
    result.push(id);
    for (const child of Object.values(storage.state.sessions)
      .filter((session) => session.parentId === id)
      .sort((left, right) => left.createdAt - right.createdAt)) {
      visit(child.id);
    }
  };
  visit(sessionId);
  return result;
}
