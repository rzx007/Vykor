import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type AdmitPromptInput,
  type AdmitPromptWithRunInput,
  type AttachmentAssetRecord,
  type AttachmentLimits,
  type SessionInputAttachmentRecord,
  type SessionInputRecord,
  type SessionRunRecord,
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
  assertSession,
  clone,
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
}
