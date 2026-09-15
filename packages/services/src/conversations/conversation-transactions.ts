import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type AdmitPromptInput,
  type AdmitPromptWithRunInput,
  type AttachmentAssetRecord,
  type AttachmentLimits,
  type CreateSessionInput,
  type ReplaceTranscriptInput,
  type SessionInputAttachmentRecord,
  type SessionInputRecord,
  type SessionMessagePartRecord,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionRunRecord,
  type SessionStateSnapshot,
  type SessionUserInputItem,
  normalizeSessionUserInputItems,
  sessionUserInputText,
  parseAttachmentLimits,
  DEFAULT_ATTACHMENT_LIMITS,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { SessionRepository } from "../sessions/session-repository.js";
import type { RunRepository } from "../runs/run-repository.js";
import { AttachmentError } from "../attachment/attachment-errors.js";
import {
  assertMutableSession,
  assertMessage,
  assertSession,
  clone,
  isTerminalAttemptStatus,
  maxSeq,
  now,
} from "../session-runtime/store-state.js";
import {
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  uniqueReferencedBytes,
} from "../session-runtime/prompt-attachments.js";
import { formatSessionTitle, isPlaceholderSessionTitle } from "../session-runtime/title.js";

export type AdmitPromptTransactionInput = Omit<AdmitPromptInput, "content" | "items"> & {
  content?: string;
  items?: readonly SessionUserInputItem[];
};

export interface ConversationTransactionTestHooks {
  afterInputWrite?: () => void;
  duringAttachmentReference?: (index: number) => void;
  afterTitleUpdate?: () => void;
  afterEventAllocation?: () => void;
  beforeRunCreation?: () => void;
  afterTranscriptReplacement?: () => void;
  afterForkSessionCreated?: () => void;
  afterForkInputsCopied?: () => void;
  afterForkMessagesCopied?: () => void;
  afterForkPartsCopied?: () => void;
  duringDeleteMemory?: () => void;
  afterDeleteMemory?: () => void;
  afterRecoveryMutation?: () => void;
}

export interface ConversationTransactionsOptions {
  storage: StorageContext;
  conversations: ConversationRepository;
  sessions?: SessionRepository;
  runs?: RunRepository;
  attachments?: {
    getAttachment?(id: string, options?: { includeDeleted?: boolean }): AttachmentAssetRecord | undefined;
    get?(id: string, options?: { includeDeleted?: boolean }): AttachmentAssetRecord | undefined;
  };
  getAttachment?: (id: string, options?: { includeDeleted?: boolean }) => AttachmentAssetRecord | undefined;
  attachmentLimits?: AttachmentLimits;
  save?: () => void;
  notifySessionTask?: (taskId: string) => void;
  testHooks?: ConversationTransactionTestHooks;
}

function metadataWithoutTrace(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { traceId: _traceId, ...stable } = metadata;
  return stable;
}

function normalizeInputItems(
  input: AdmitPromptTransactionInput,
): SessionUserInputItem[] {
  if (input.items !== undefined)
    return normalizeSessionUserInputItems(input.items);
  return normalizeSessionUserInputItems(
    input.content === undefined ? [] : [{ type: "text", text: input.content }],
  );
}

export class ConversationTransactions {
  private readonly storage: StorageContext;
  private readonly conversations: ConversationRepository;
  private readonly sessions?: SessionRepository;
  private readonly runs?: RunRepository;
  private readonly options: ConversationTransactionsOptions;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly saveChanges?: () => void;
  private testHooks?: ConversationTransactionTestHooks;

  constructor(options: ConversationTransactionsOptions) {
    this.options = options;
    this.storage = options.storage;
    this.conversations = options.conversations;
    this.sessions = options.sessions;
    this.runs = options.runs;
    this.saveChanges = options.save;
    this.testHooks = options.testHooks;
    this.attachmentLimits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.attachmentLimits,
    });
  }

  setTestHooks(hooks?: ConversationTransactionTestHooks): void {
    this.testHooks = hooks;
  }

  private getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    if (this.options.getAttachment) {
      return this.options.getAttachment(id, options);
    }
    if (this.options.attachments) {
      if (typeof this.options.attachments.getAttachment === "function") {
        return this.options.attachments.getAttachment(id, options);
      }
      if (typeof this.options.attachments.get === "function") {
        return this.options.attachments.get(id, options);
      }
    }
    return undefined;
  }

  admitPrompt(
    input: AdmitPromptTransactionInput,
    options: { attachmentLimits?: Partial<AttachmentLimits> } = {},
  ): SessionInputRecord {
    return this.storage.atomic(() => {
      const attachmentLimits = options.attachmentLimits
        ? parseAttachmentLimits({
            ...this.attachmentLimits,
            ...options.attachmentLimits,
          })
        : this.attachmentLimits;
      const session = assertSession(this.storage.state, input.sessionId);
      assertMutableSession(session);
      const items = normalizeInputItems(input);
      const content = sessionUserInputText(items);
      const normalized = normalizePromptAttachments(input.attachments);
      if (
        content.trim().length === 0 &&
        normalized.length === 0 &&
        !items.some((item) => item.type !== "text")
      ) {
        throw new AttachmentError(
          "prompt_content_required",
          "Prompt text and attachments cannot both be empty",
        );
      }
      if (normalized.length > attachmentLimits.maxFilesPerPrompt) {
        throw new AttachmentError(
          "attachment_count_exceeded",
          `Prompt references ${normalized.length} files; limit is ${attachmentLimits.maxFilesPerPrompt}`,
        );
      }

      const id = input.id ?? randomUUID();
      const delivery =
        normalized.length > 0 && input.delivery === "steer"
          ? "queue"
          : (input.delivery ?? "queue");
      const metadata = input.metadata ?? {};
      const existing = this.storage.state.inputs[id];
      if (existing) {
        const existingRequested = existing.attachments.map((reference) => ({
          assetId: reference.assetId,
          intent: reference.intent,
          ...(typeof reference.metadata.requestedDisplayName === "string"
            ? { displayName: reference.metadata.requestedDisplayName }
            : {}),
        }));
        const same =
          existing.sessionId === input.sessionId &&
          isDeepStrictEqual(existing.items, items) &&
          existing.delivery === delivery &&
          isDeepStrictEqual(
            metadataWithoutTrace(existing.metadata),
            metadataWithoutTrace(metadata),
          ) &&
          promptAttachmentFingerprint(existingRequested) ===
            promptAttachmentFingerprint(normalized);
        if (!same) {
          throw new AttachmentError(
            "prompt_id_conflict",
            `Input ${id} already exists with different content`,
          );
        }
        return clone(existing);
      }

      const assets = normalized.map((reference) => {
        const asset = this.getAttachment(reference.assetId, {
          includeDeleted: true,
        });
        if (!asset || asset.status === "deleted") {
          throw new AttachmentError(
            "attachment_not_found",
            `Attachment ${reference.assetId} was not found`,
          );
        }
        if (
          asset.status !== "ready" ||
          asset.sizeBytes === undefined ||
          asset.mediaType === undefined
        ) {
          throw new AttachmentError(
            "attachment_not_ready",
            `Attachment ${reference.assetId} is ${asset.status}`,
          );
        }
        if (asset.sizeBytes > attachmentLimits.maxBytesPerFile) {
          throw new AttachmentError(
            "attachment_too_large",
            `Attachment ${reference.assetId} exceeds the per-file limit`,
          );
        }
        return { reference, asset };
      });
      const promptBytes = assets.reduce(
        (total, entry) => total + entry.asset.sizeBytes!,
        0,
      );
      if (promptBytes > attachmentLimits.maxBytesPerPrompt) {
        throw new AttachmentError(
          "attachment_prompt_size_exceeded",
          `Prompt attachments use ${promptBytes} bytes; limit is ${attachmentLimits.maxBytesPerPrompt}`,
        );
      }
      const sessionBytes = uniqueReferencedBytes(
        Object.values(this.storage.state.inputAttachments).filter(
          (reference) => reference.sessionId === input.sessionId,
        ),
        assets.map(({ asset }) => ({
          assetId: asset.id,
          sizeBytes: asset.sizeBytes!,
        })),
      );
      if (sessionBytes > attachmentLimits.maxSessionReferencedBytes) {
        throw new AttachmentError(
          "attachment_session_size_exceeded",
          `Session attachments use ${sessionBytes} bytes; limit is ${attachmentLimits.maxSessionReferencedBytes}`,
        );
      }

      const timestamp = now();
      const seq = maxSeq(this.storage.state.inputs, input.sessionId) + 1;
      const attachments: SessionInputAttachmentRecord[] = assets.map(
        ({ reference, asset }, attachmentSeq) => ({
          id: randomUUID(),
          sessionId: input.sessionId,
          inputId: id,
          assetId: asset.id,
          seq: attachmentSeq,
          intent: reference.intent,
          displayName: reference.displayName ?? asset.displayName,
          mediaType: asset.mediaType!,
          sizeBytes: asset.sizeBytes!,
          metadata:
            reference.displayName === undefined
              ? {}
              : { requestedDisplayName: reference.displayName },
          createdAt: timestamp,
        }),
      );
      const row: SessionInputRecord = {
        id,
        sessionId: input.sessionId,
        seq,
        delivery,
        items,
        content,
        attachments,
        metadata,
        createdAt: timestamp,
      };
      this.storage.state.inputs[id] = row;
      this.storage.mutations.inputs.add(id);
      this.testHooks?.afterInputWrite?.();

      for (let i = 0; i < attachments.length; i++) {
        this.testHooks?.duringAttachmentReference?.(i);
        const reference = attachments[i]!;
        this.storage.state.inputAttachments[reference.id] = reference;
        this.storage.mutations.inputAttachments.add(reference.id);
      }

      session.updatedAt = timestamp;
      if (seq === 1 && isPlaceholderSessionTitle(session.title)) {
        const title = formatSessionTitle(content);
        if (title) session.title = title;
      }
      this.storage.mutations.sessions.add(input.sessionId);
      this.testHooks?.afterTitleUpdate?.();

      this.conversations.appendEventInMemory({
        type: "session.input.admitted",
        sessionId: input.sessionId,
        payload: { input: row },
      });
      this.testHooks?.afterEventAllocation?.();

      this.saveChanges?.();
      return clone(row);
    });
  }

  private requireRuns(): RunRepository {
    if (!this.runs) {
      throw new Error("RunRepository is required for run transactions");
    }
    return this.runs;
  }

  admitPromptWithRun(
    input: AdmitPromptWithRunInput,
    options: { attachmentLimits?: Partial<AttachmentLimits> } = {},
  ): {
    input: SessionInputRecord;
    run: SessionRunRecord;
  } {
    if (input.prompt.delivery === "steer") {
      throw new Error(
        "Steered prompts cannot create their owning run during admission",
      );
    }
    return this.storage.atomic(() => {
      const admitted = this.admitPrompt(
        {
          ...input.prompt,
          delivery: "queue",
        },
        options,
      );
      const runs = this.requireRuns();
      const existingRun = runs.findOwningRunByInput(admitted.id);
      if (existingRun) return { input: admitted, run: existingRun };
      this.testHooks?.beforeRunCreation?.();
      const run = runs.createRun({
        id: input.run?.id,
        sessionId: admitted.sessionId,
        inputId: admitted.id,
        metadata: input.run?.metadata,
      });
      return { input: admitted, run };
    });
  }

  createReplayRun(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown> } = {},
  ): SessionRunRecord {
    return this.storage.atomic(() => {
      const sourceInput = this.storage.state.inputs[inputId];
      if (!sourceInput) throw new Error(`Session input not found: ${inputId}`);
      if (input.id) {
        const existing = this.storage.state.runs[input.id];
        if (existing) {
          if (
            existing.sessionId !== sourceInput.sessionId ||
            existing.inputId !== sourceInput.id
          ) {
            throw new Error(`Replay run id is already used: ${input.id}`);
          }
          return clone(existing);
        }
      }
      return this.requireRuns().createRun({
        id: input.id,
        sessionId: sourceInput.sessionId,
        inputId: sourceInput.id,
        metadata: input.metadata,
      });
    });
  }

  private requireSessions(): SessionRepository {
    if (!this.sessions) {
      throw new Error("SessionRepository is required for session transactions");
    }
    return this.sessions;
  }

  replaceTranscript(input: ReplaceTranscriptInput): {
    messages: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  } {
    return this.storage.atomic(() => {
      const session = assertSession(this.storage.state, input.sessionId);
      const timestamp = now();

      for (const [id, message] of Object.entries(this.storage.state.messages)) {
        if (message.sessionId !== input.sessionId) continue;
        delete this.storage.state.messages[id];
        this.storage.mutations.messages.delete(id);
        this.storage.mutations.deletedMessages.add(id);
      }
      for (const [id, part] of Object.entries(this.storage.state.parts)) {
        if (part.sessionId !== input.sessionId) continue;
        delete this.storage.state.parts[id];
        this.storage.mutations.parts.delete(id);
        this.storage.mutations.deletedParts.add(id);
        this.storage.deltaCheckpoint.delete(id);
      }

      const messages: SessionMessageRecord[] = [];
      const parts: SessionMessagePartRecord[] = [];
      let messageSeq = 0;
      let partSeq = 0;
      for (const row of input.messages) {
        const messageId = randomUUID();
        const message: SessionMessageRecord = {
          id: messageId,
          sessionId: input.sessionId,
          seq: ++messageSeq,
          role: row.role,
          metadata: row.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.storage.state.messages[messageId] = message;
        this.storage.mutations.messages.add(messageId);
        messages.push(message);

        for (const partInput of row.parts) {
          const partId = randomUUID();
          const part: SessionMessagePartRecord = {
            id: partId,
            sessionId: input.sessionId,
            messageId,
            seq: ++partSeq,
            type: partInput.type,
            status: partInput.status ?? "completed",
            ...(partInput.text !== undefined ? { text: partInput.text } : {}),
            ...(partInput.toolUseId !== undefined ? { toolUseId: partInput.toolUseId } : {}),
            ...(partInput.toolName !== undefined ? { toolName: partInput.toolName } : {}),
            ...(partInput.input !== undefined ? { input: partInput.input } : {}),
            ...(partInput.output !== undefined ? { output: partInput.output } : {}),
            ...(partInput.isError !== undefined ? { isError: partInput.isError } : {}),
            ...(partInput.assetId !== undefined ? { assetId: partInput.assetId } : {}),
            ...(partInput.intent !== undefined ? { intent: partInput.intent } : {}),
            ...(partInput.displayName !== undefined ? { displayName: partInput.displayName } : {}),
            ...(partInput.mediaType !== undefined ? { mediaType: partInput.mediaType } : {}),
            ...(partInput.sizeBytes !== undefined ? { sizeBytes: partInput.sizeBytes } : {}),
            ...(partInput.kind !== undefined ? { kind: partInput.kind } : {}),
            ...(partInput.representationId !== undefined ? { representationId: partInput.representationId } : {}),
            ...(partInput.processor !== undefined ? { processor: partInput.processor } : {}),
            ...(partInput.transformationError !== undefined ? { transformationError: partInput.transformationError } : {}),
            metadata: partInput.metadata ?? {},
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          this.storage.state.parts[partId] = part;
          this.storage.mutations.parts.add(partId);
          parts.push(part);
        }
      }

      session.updatedAt = timestamp;
      this.storage.mutations.sessions.add(input.sessionId);
      this.conversations.appendEventInMemory({
        type: "session.transcript.replaced",
        sessionId: input.sessionId,
        payload: { messages: clone(messages), parts: clone(parts) },
      });
      this.testHooks?.afterTranscriptReplacement?.();
      this.saveChanges?.();
      return { messages: clone(messages), parts: clone(parts) };
    });
  }

  replaceTranscriptAndAdmitPrompt(input: {
    transcript: ReplaceTranscriptInput;
    admission: AdmitPromptWithRunInput;
    createRun: boolean;
  }): {
    transcript: { messages: SessionMessageRecord[]; parts: SessionMessagePartRecord[] };
    input: SessionInputRecord;
    run?: SessionRunRecord;
  } {
    return this.storage.atomic(() => {
      const transcript = this.replaceTranscript(input.transcript);
      const admitted = input.createRun
        ? this.admitPromptWithRun(input.admission)
        : { input: this.admitPrompt(input.admission.prompt) };
      return { transcript, ...admitted };
    });
  }

  replaceLatestPromptWithAdmission(input: {
    sessionId: string;
    sourceMessageId: string;
    admission: AdmitPromptWithRunInput;
    createRun: boolean;
  }): {
    transcript: { messages: SessionMessageRecord[]; parts: SessionMessagePartRecord[] };
    input: SessionInputRecord;
    run?: SessionRunRecord;
  } {
    return this.storage.atomic(() => {
      const session = assertSession(this.storage.state, input.sessionId);
      const sourceMessage = assertMessage(this.storage.state, input.sourceMessageId);
      if (sourceMessage.sessionId !== input.sessionId || sourceMessage.role !== "user") {
        throw new Error("The edit source must be a user message in the session");
      }
      const sourceInput = sourceMessage.inputId
        ? this.storage.state.inputs[sourceMessage.inputId]
        : undefined;
      if (!sourceInput || sourceInput.sessionId !== input.sessionId) {
        throw new Error("The edit source input is unavailable");
      }

      const removedMessages = Object.values(this.storage.state.messages).filter(
        (message) => message.sessionId === input.sessionId && message.seq >= sourceMessage.seq,
      );
      const removedMessageIds = new Set(removedMessages.map(({ id }) => id));
      const removedInputs = Object.values(this.storage.state.inputs).filter(
        (candidate) => candidate.sessionId === input.sessionId && candidate.seq >= sourceInput.seq,
      );
      const removedInputIds = new Set(removedInputs.map(({ id }) => id));
      const removedRuns = Object.values(this.storage.state.runs).filter(
        (run) => run.sessionId === input.sessionId &&
          (removedInputIds.has(run.inputId ?? "") || removedMessages.some((message) => message.runId === run.id)),
      );
      const removedRunIds = new Set(removedRuns.map(({ id }) => id));

      for (const [id, part] of Object.entries(this.storage.state.parts)) {
        if (!removedMessageIds.has(part.messageId)) continue;
        delete this.storage.state.parts[id];
        this.storage.mutations.parts.delete(id);
        this.storage.mutations.deletedParts.add(id);
        this.storage.deltaCheckpoint.delete(id);
      }
      for (const message of removedMessages) {
        delete this.storage.state.messages[message.id];
        this.storage.mutations.messages.delete(message.id);
        this.storage.mutations.deletedMessages.add(message.id);
      }
      for (const [id, reference] of Object.entries(this.storage.state.inputAttachments)) {
        if (!removedInputIds.has(reference.inputId)) continue;
        delete this.storage.state.inputAttachments[id];
        this.storage.mutations.inputAttachments.delete(id);
        this.storage.mutations.deletedInputAttachments.add(id);
      }
      for (const [id, attempt] of Object.entries(this.storage.state.attempts)) {
        if (!removedRunIds.has(attempt.runId)) continue;
        delete this.storage.state.attempts[id];
        this.storage.mutations.attempts.delete(id);
        this.storage.mutations.deletedAttempts.add(id);
      }
      for (const run of removedRuns) {
        delete this.storage.state.runs[run.id];
        this.storage.mutations.runs.delete(run.id);
        this.storage.mutations.deletedRuns.add(run.id);
      }
      for (const candidate of removedInputs) {
        delete this.storage.state.inputs[candidate.id];
        this.storage.mutations.inputs.delete(candidate.id);
        this.storage.mutations.deletedInputs.add(candidate.id);
      }
      this.refreshSessionStatus(session);

      const transcript = {
        messages: this.conversations.listMessages(input.sessionId),
        parts: this.conversations.listMessageParts(input.sessionId),
      };
      this.conversations.appendEventInMemory({
        type: "session.transcript.replaced",
        sessionId: input.sessionId,
        payload: { messages: transcript.messages, parts: transcript.parts },
      });
      const admitted = input.createRun
        ? this.admitPromptWithRun(input.admission)
        : { input: this.admitPrompt(input.admission.prompt) };
      return { transcript, ...admitted };
    });
  }

  private refreshSessionStatus(session: SessionRecord): void {
    if (session.status === "archived" || session.status === "closing") return;
    const hasActiveRun = Object.values(this.storage.state.runs).some(
      (run) => run.sessionId === session.id && (run.status === "pending" || run.status === "running"),
    );
    session.status = hasActiveRun ? "running" : "idle";
  }

  forkSessionWithHistory(input: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    session: CreateSessionInput;
  }): SessionRecord {
    return this.storage.atomic(() => {
      const source = assertSession(this.storage.state, input.sourceSessionId);
      const sourceMessages = this.conversations.listMessages(source.id);
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
      const sourceParts = this.conversations.listMessageParts(source.id);
      const fork = this.requireSessions().create({ ...input.session, parentId: source.id });
      this.testHooks?.afterForkSessionCreated?.();

      const inputIdMap = new Map<string, string>();
      const attachmentReferenceIdMap = new Map<string, string>();
      for (const message of copiedMessages) {
        if (!message.inputId || inputIdMap.has(message.inputId)) continue;
        const sourceInput = this.storage.state.inputs[message.inputId];
        if (!sourceInput) continue;
        const copiedInput = this.admitPrompt({
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
      this.testHooks?.afterForkInputsCopied?.();

      const messageIdMap = new Map<string, string>();
      for (const message of copiedMessages) {
        const copiedMessage = this.conversations.createMessage({
          sessionId: fork.id,
          role: message.role,
          ...(message.inputId && inputIdMap.has(message.inputId)
            ? { inputId: inputIdMap.get(message.inputId)! }
            : {}),
          metadata: message.metadata,
        });
        messageIdMap.set(message.id, copiedMessage.id);
      }
      this.testHooks?.afterForkMessagesCopied?.();

      for (const part of sourceParts) {
        const messageId = messageIdMap.get(part.messageId);
        if (!messageId) continue;
        const sourceReferenceId = typeof part.metadata.inputAttachmentId === "string"
          ? part.metadata.inputAttachmentId
          : undefined;
        this.conversations.upsertMessagePart({
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
      this.testHooks?.afterForkPartsCopied?.();
      return clone(assertSession(this.storage.state, fork.id));
    });
  }

  deleteSessionTree(sessionId: string): string[] {
    if (this.storage.coordinator?.inTransaction) {
      throw new Error("deleteSessionTree cannot be called inside a store transaction");
    }
    assertSession(this.storage.state, sessionId);
    const sessionIds = this.collectSessionTreeIds(sessionId);
    const sessionIdSet = new Set(sessionIds);
    const runIds = new Set(
      Object.values(this.storage.state.runs)
        .filter((run) => sessionIdSet.has(run.sessionId))
        .map(({ id }) => id),
    );

    return this.storage.atomic(() => {
      const placeholders = sessionIds.map(() => "?").join(", ");
      const database = this.storage.database.connection;
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
        delete this.storage.state.sessions[id];
        this.storage.mutations.sessions.delete(id);
      }
      this.testHooks?.duringDeleteMemory?.();
      for (const [id, row] of Object.entries(this.storage.state.inputs)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.inputs[id];
        this.storage.mutations.inputs.delete(id);
        this.storage.mutations.deletedInputs.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.inputAttachments)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.inputAttachments[id];
        this.storage.mutations.inputAttachments.delete(id);
        this.storage.mutations.deletedInputAttachments.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.messages)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.messages[id];
        this.storage.mutations.messages.delete(id);
        this.storage.mutations.deletedMessages.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.parts)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.parts[id];
        this.storage.mutations.parts.delete(id);
        this.storage.mutations.deletedParts.delete(id);
        this.storage.deltaCheckpoint.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.runs)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.runs[id];
        this.storage.mutations.runs.delete(id);
        this.storage.mutations.deletedRuns.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.attempts)) {
        if (!runIds.has(row.runId)) continue;
        delete this.storage.state.attempts[id];
        this.storage.mutations.attempts.delete(id);
        this.storage.mutations.deletedAttempts.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.tasks)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.tasks[id];
        this.storage.mutations.tasks.delete(id);
      }
      for (const [id, row] of Object.entries(this.storage.state.permissions)) {
        if (!sessionIdSet.has(row.sessionId)) continue;
        delete this.storage.state.permissions[id];
        this.storage.mutations.permissions.delete(id);
      }
      const removedEventIds = new Set(
        this.storage.state.events
          .filter((event) => event.sessionId && sessionIdSet.has(event.sessionId))
          .map(({ id }) => id),
      );
      this.storage.state.events = this.storage.state.events.filter(
        (event) => !event.sessionId || !sessionIdSet.has(event.sessionId),
      );
      for (const id of removedEventIds) this.storage.mutations.events.delete(id);
      this.testHooks?.afterDeleteMemory?.();
      return sessionIds;
    });
  }

  private collectSessionTreeIds(sessionId: string): string[] {
    const result: string[] = [];
    const visit = (id: string): void => {
      result.push(id);
      for (const child of Object.values(this.storage.state.sessions)
        .filter((session) => session.parentId === id)
        .sort((left, right) => left.createdAt - right.createdAt)) {
        visit(child.id);
      }
    };
    visit(sessionId);
    return result;
  }

  private notifyTaskAfterCommit(taskId: string): void {
    const notify = this.options.notifySessionTask;
    if (!notify) return;
    if (this.storage.deferUntilCommit) this.storage.deferUntilCommit(() => notify(taskId));
    else notify(taskId);
  }

  settleActiveRunAttempts(runId: string, status: "completed" | "failed" | "cancelled", error?: string): number {
    return this.storage.atomic(() => {
      const active = Object.values(this.storage.state.attempts).filter(
        (attempt) => attempt.runId === runId && !isTerminalAttemptStatus(attempt.status),
      );
      for (const attempt of active) {
        this.requireRuns().updateRunAttempt(attempt.id, {
          status,
          ...(error ? { error, errorKind: status === "cancelled" ? "interrupted" : "provider" } : {}),
        });
        this.testHooks?.afterRecoveryMutation?.();
      }
      return active.length;
    });
  }

  interruptActiveSessionTasks(reason = "Daemon restarted before the task completed"): number {
    return this.storage.atomic(() => {
      const active = Object.values(this.storage.state.tasks).filter(
        (task) => task.status === "pending" || task.status === "running",
      );
      for (const task of active) {
        this.requireRuns().updateSessionTask(task.id, { status: "interrupted", error: reason });
        this.notifyTaskAfterCommit(task.id);
        this.testHooks?.afterRecoveryMutation?.();
      }
      return active.length;
    });
  }

  interruptActiveRuns(reason = "Daemon restarted before the run completed"): number {
    return this.storage.atomic(() => {
      const active = Object.values(this.storage.state.runs).filter(
        (run) => run.status === "pending" || run.status === "running",
      );
      for (const run of active) {
        const messageIds = new Set(Object.values(this.storage.state.messages)
          .filter((message) => message.runId === run.id).map(({ id }) => id));
        for (const part of Object.values(this.storage.state.parts)) {
          if (!messageIds.has(part.messageId) || part.status !== "running") continue;
          this.conversations.upsertMessagePart({
            id: part.id, sessionId: part.sessionId, messageId: part.messageId, type: part.type,
            status: part.type === "tool" ? "failed" : "interrupted",
            ...(part.type === "tool" ? { metadata: {
              ...part.metadata,
              toolCallId: part.toolUseId ?? part.id,
              toolAttemptId: typeof part.metadata.toolAttemptId === "string"
                ? part.metadata.toolAttemptId : `tool_attempt_${part.toolUseId ?? part.id}_1`,
              outcome: "unknown", failureKind: "unknown_outcome",
              outcomeWarning: "Tool may already have executed; automatic retry is disabled",
            } } : {}),
          });
        }
        this.settleActiveRunAttempts(run.id, "cancelled", reason);
        this.requireRuns().updateRun(run.id, { status: "interrupted", error: reason });
        this.testHooks?.afterRecoveryMutation?.();
      }
      return active.length;
    });
  }

  terminalizeUnownedInputs(reason = "Daemon restarted before the input was assigned to a run"): number {
    return this.storage.atomic(() => {
      const runs = this.requireRuns();
      const unowned = Object.values(this.storage.state.inputs).filter((input) => {
        const session = this.storage.state.sessions[input.sessionId];
        return session !== undefined && session.status !== "archived" && session.status !== "closing"
          && runs.findRunByInput(input.id) === undefined;
      });
      for (const input of unowned) {
        const traceId = typeof input.metadata.traceId === "string" ? input.metadata.traceId : undefined;
        const run = runs.createRun({
          sessionId: input.sessionId, inputId: input.id,
          metadata: {
            ...(traceId ? { traceId } : {}),
            recovery: { kind: "orphan_input", inputId: input.id, delivery: input.delivery, reason },
          },
        });
        runs.updateRun(run.id, { status: "interrupted", error: reason });
        this.testHooks?.afterRecoveryMutation?.();
      }
      return unowned.length;
    });
  }

  finalizeClosingSessions(): number {
    return this.storage.atomic(() => {
      const closing = Object.values(this.storage.state.sessions).filter(({ status }) => status === "closing");
      for (const session of closing) {
        const hasActiveRun = Object.values(this.storage.state.runs).some(
          (run) => run.sessionId === session.id && (run.status === "pending" || run.status === "running"),
        );
        if (!hasActiveRun) this.requireSessions().archive(session.id);
        this.testHooks?.afterRecoveryMutation?.();
      }
      return closing.length;
    });
  }

  getSessionState(sessionId: string): SessionStateSnapshot {
    const session = assertSession(this.storage.state, sessionId);
    const runs = Object.values(this.storage.state.runs)
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt);
    return clone({
      cursor: this.storage.state.nextEventSeq - 1,
      session,
      inputs: this.conversations.listInputs(sessionId),
      messages: this.conversations.listMessages(sessionId),
      parts: this.conversations.listMessageParts(sessionId),
      runs,
      attempts: Object.values(this.storage.state.attempts)
        .filter((attempt) => this.storage.state.runs[attempt.runId]?.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence),
      tasks: Object.values(this.storage.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt),
      permissions: Object.values(this.storage.state.permissions)
        .filter((request) => request.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt),
    });
  }
}
