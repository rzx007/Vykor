import type { ReasoningSource, StreamEvent } from "@vykor/core";
import { externalToolMetadata, toolFeedbackFields } from "@vykor/core";
import type { AssistantMessagePhase } from "@vykor/core";
import type { SessionStore } from "@vykor/services";
import type {
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartStatus,
} from "@vykor/protocol";
import type { AttachmentRoutingDecision } from "../attachments/routing/attachment-routing-types.js";

const REASONING_PART_CHAR_LIMIT = 1_000_000;
const REASONING_TRUNCATION_NOTICE = "\n\n…（思考内容过长，已截断）";

type ActiveToolPart = {
  partId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ActiveTranscriptProjectionState = {
  sessionId: string;
  runId: string;
  inputId: string;
  requestConfiguration?: {
    revision: number;
    model: string;
    provider?: string;
    effort?: string;
  };
  assistantMessageId?: string;
  assistantTurnCompleted: boolean;
  activeTextPartId?: string;
  activeTextPhase?: AssistantMessagePhase;
  activeReasoningPartId?: string;
  activeReasoningSource?: ReasoningSource;
  reasoningChars?: number;
  reasoningTruncated?: boolean;
  toolParts: Map<string, ActiveToolPart>;
};

export type AppliedTranscriptStreamEvent = {
  liveEvent?: SessionEventRecord;
  completedToolName?: string;
};

/**
 * Transcript projection sink for one run.
 *
 * It is the only place that knows how runtime StreamEvents become durable
 * messages, text parts, tool parts, and part-delta events.
 */
export class SessionTranscriptProjection {
  constructor(
    private readonly store: Pick<SessionStore, "conversations" | "incrementalOutput" | "runs">,
  ) {}

  beginRun(
    sessionId: string,
    inputId: string,
    runId: string,
    input: SessionInputRecord,
  ): ActiveTranscriptProjectionState {
    if (input.metadata.transcriptVisibility !== "hidden") {
      const existingUserMessage = this.store.conversations
        .listMessages(sessionId)
        .find((message) => message.inputId === inputId);
      if (!existingUserMessage) {
        const userMessage = this.store.conversations.createMessage({
          sessionId,
          role: "user",
          runId,
          inputId,
        });
        this.projectUserInput(userMessage.id, input);
      }
    }
    return {
      sessionId,
      runId,
      inputId,
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
  }

  projectAttachmentTransformations(input: {
    sessionId: string;
    inputId: string;
    runId: string;
    input: SessionInputRecord;
    decisions: AttachmentRoutingDecision[];
    status: Extract<SessionMessagePartStatus, "completed" | "failed">;
    errorCode?: string;
  }): void {
    let userMessage = this.store.conversations
      .listMessages(input.sessionId)
      .find((message) => message.inputId === input.inputId);
    if (!userMessage) {
      userMessage = this.store.conversations.createMessage({
        sessionId: input.sessionId,
        role: "user",
        runId: input.runId,
        inputId: input.inputId,
      });
      this.projectUserInput(userMessage.id, input.input);
    }
    for (const decision of input.decisions) {
      this.store.conversations.upsertMessagePart({
        id: `attachment-transform:${input.runId}:${decision.assetId}`,
        sessionId: input.sessionId,
        messageId: userMessage.id,
        type: "transformation",
        status: input.status,
        assetId: decision.assetId,
        kind: "direct",
        ...(input.errorCode ? { transformationError: input.errorCode } : {}),
        metadata: {
          route: decision.route,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.complete !== undefined ? { complete: decision.complete } : {}),
          ...(decision.resourceUri ? { resourceUri: decision.resourceUri } : {}),
        },
      });
    }
  }

  projectSteeredInputs(state: ActiveTranscriptProjectionState, pending: SessionInputRecord[]): void {
    this.completeOpenReasoningPart(state, "completed");
    this.completeOpenTextPart(state, "completed");
    delete state.assistantMessageId;
    state.assistantTurnCompleted = true;
    for (const steered of pending) {
      if (this.store.conversations.listMessages(state.sessionId).some((message) => message.inputId === steered.id)) continue;
      const userMessage = this.store.conversations.createMessage({
        sessionId: state.sessionId,
        role: "user",
        runId: state.runId,
        inputId: steered.id,
      });
      this.projectUserInput(userMessage.id, steered);
    }
  }

  hasOpenTextPart(state: ActiveTranscriptProjectionState): boolean {
    return Boolean(state.activeTextPartId);
  }

  projectStreamEvent(
    state: ActiveTranscriptProjectionState,
    event: StreamEvent,
  ): AppliedTranscriptStreamEvent {
    switch (event.type) {
      case "reasoning_delta": {
        this.completeOpenTextPart(state, "completed", "commentary");
        if (state.activeReasoningPartId && state.activeReasoningSource !== event.source) {
          this.completeOpenReasoningPart(state, "completed");
        }
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeReasoningPartId) {
          const part = this.store.conversations.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "reasoning",
            status: "running",
            text: "",
            metadata: { source: event.source },
          });
          state.activeReasoningPartId = part.id;
          state.activeReasoningSource = event.source;
        }
        const delta = this.takeReasoningDelta(state, event.delta);
        if (!delta) return {};
        return {
          liveEvent: this.store.incrementalOutput.appendMessagePartDelta({
            sessionId: state.sessionId,
            messageId,
            partId: state.activeReasoningPartId,
            field: "reasoning",
            delta,
          }),
        };
      }
      case "text_delta": {
        this.completeOpenReasoningPart(state, "completed");
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeTextPartId) {
          const part = this.store.conversations.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "text",
            status: "running",
            text: "",
            ...(event.phase ? { metadata: { phase: event.phase } } : {}),
          });
          state.activeTextPartId = part.id;
          state.activeTextPhase = event.phase;
        }
        return {
          liveEvent: this.store.incrementalOutput.appendMessagePartDelta({
            sessionId: state.sessionId,
            messageId,
            partId: state.activeTextPartId,
            field: "text",
            delta: event.delta,
          }),
        };
      }
      case "tool_use_start": {
        this.completeOpenReasoningPart(state, "completed");
        this.completeOpenTextPart(state, "completed", "commentary");
        const messageId = this.ensureAssistantMessage(state, true);
        const part = this.store.conversations.upsertMessagePart({
          id: event.toolUse.id,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: "running",
          toolUseId: event.toolUse.id,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
          metadata: {
            toolCallId: event.toolUse.id,
            toolAttemptId: `tool_attempt_${event.toolUse.id}_1`,
            outcome: "pending",
          },
        });
        state.toolParts.set(event.toolUse.id, {
          partId: part.id,
          messageId,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        return {};
      }
      case "tool_use_end": {
        const active = state.toolParts.get(event.toolUseId);
        const messageId = active?.messageId ?? this.ensureAssistantMessage(state);
        const attachmentOcr = recordValue(event.result.metadata?.attachmentOcr);
        const feedback = toolFeedbackFields(event.result);
        this.store.conversations.upsertMessagePart({
          id: active?.partId ?? event.toolUseId,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: event.result.isError ? "failed" : "completed",
          toolUseId: event.toolUseId,
          ...(active?.toolName ? { toolName: active.toolName } : {}),
          ...(active?.input ? { input: active.input } : {}),
          output: event.result,
          isError: event.result.isError === true,
          ...(typeof attachmentOcr?.assetId === "string"
            ? { assetId: attachmentOcr.assetId }
            : {}),
          ...(typeof attachmentOcr?.representationId === "string"
            ? { representationId: attachmentOcr.representationId }
            : {}),
          ...(typeof attachmentOcr?.processor === "string"
            ? { processor: attachmentOcr.processor }
            : {}),
          metadata: {
            ...externalToolMetadata(event.result.metadata),
            toolCallId: event.toolUseId,
            toolAttemptId: event.result.toolAttemptId ?? `tool_attempt_${event.toolUseId}_1`,
            outcome: event.result.isError ? "failed" : "completed",
            ...feedback,
            ...(Object.keys(feedback).length ? { toolFeedbackVersion: 1 } : {}),
          },
        });
        if (!event.result.isError) {
          for (const [index, image] of generatedImageAssets(
            event.result.metadata?.generatedImages,
          ).entries()) {
            this.store.conversations.upsertMessagePart({
              id: `generated-attachment:${event.toolUseId}:${index}`,
              sessionId: state.sessionId,
              messageId,
              type: "attachment",
              status: "completed",
              assetId: image.assetId,
              intent: "tool_resource",
              displayName: image.displayName,
              mediaType: image.mediaType,
              sizeBytes: image.sizeBytes,
              metadata: {
                source: "image_generation",
                toolUseId: event.toolUseId,
              },
            });
          }
        }
        state.toolParts.delete(event.toolUseId);
        return { completedToolName: active?.toolName };
      }
      case "usage": {
        this.store.runs.updateRun(state.runId, { metadata: { usage: event.usage } });
        return {};
      }
      case "complete": {
        this.completeOpenReasoningPart(state, "completed");
        this.completeOpenTextPart(
          state,
          "completed",
          state.activeTextPhase ?? "final_answer",
        );
        state.assistantTurnCompleted = true;
        this.store.runs.updateRun(state.runId, { metadata: { stopReason: event.stopReason } });
        return {};
      }
      case "error": {
        const messageId = this.ensureAssistantMessage(state, true);
        this.completeOpenReasoningPart(state, "completed");
        this.completeOpenTextPart(state, "failed");
        this.store.conversations.upsertMessagePart({
          sessionId: state.sessionId,
          messageId,
          type: "error",
          status: "failed",
          text: event.error.message,
        });
        return {};
      }
    }
  }

  completeOpenTextPart(
    state: ActiveTranscriptProjectionState,
    status: Extract<SessionMessagePartStatus, "completed" | "failed" | "interrupted">,
    phase?: AssistantMessagePhase,
  ): void {
    if (!state.assistantMessageId || !state.activeTextPartId) return;
    this.store.conversations.upsertMessagePart({
      id: state.activeTextPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "text",
      status,
      ...(phase ? { metadata: { phase } } : {}),
    });
    delete state.activeTextPartId;
    delete state.activeTextPhase;
  }

  completeOpenReasoningPart(
    state: ActiveTranscriptProjectionState,
    status: Extract<SessionMessagePartStatus, "completed" | "failed" | "interrupted">,
  ): void {
    if (!state.assistantMessageId || !state.activeReasoningPartId) return;
    this.store.conversations.upsertMessagePart({
      id: state.activeReasoningPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "reasoning",
      status,
    });
    delete state.activeReasoningPartId;
    delete state.activeReasoningSource;
    delete state.reasoningChars;
    delete state.reasoningTruncated;
  }

  private takeReasoningDelta(
    state: ActiveTranscriptProjectionState,
    delta: string,
  ): string {
    const used = state.reasoningChars ?? 0;
    if (used >= REASONING_PART_CHAR_LIMIT) {
      if (state.reasoningTruncated) return "";
      state.reasoningTruncated = true;
      return REASONING_TRUNCATION_NOTICE;
    }
    if (used + delta.length <= REASONING_PART_CHAR_LIMIT) {
      state.reasoningChars = used + delta.length;
      return delta;
    }
    state.reasoningChars = REASONING_PART_CHAR_LIMIT;
    state.reasoningTruncated = true;
    return delta.slice(0, REASONING_PART_CHAR_LIMIT - used) + REASONING_TRUNCATION_NOTICE;
  }

  /** Closes parts left running when event delivery fails before terminal events are projected. */
  finalizeRunParts(
    sessionId: string,
    runId: string,
    status: Extract<SessionMessagePartStatus, "failed" | "interrupted">,
  ): void {
    const messageIds = new Set(
      this.store.conversations
        .listMessages(sessionId)
        .filter((message) => message.runId === runId)
        .map((message) => message.id),
    );
    for (const part of this.store.conversations.listMessageParts(sessionId)) {
      if (!messageIds.has(part.messageId) || part.status !== "running") continue;
      this.store.conversations.upsertMessagePart({
        id: part.id,
        sessionId,
        messageId: part.messageId,
        type: part.type,
        status,
        ...(part.type === "tool" ? {
          metadata: {
            ...part.metadata,
            outcome: status,
            failureKind: status === "interrupted" ? "interrupted" : "unknown_outcome",
            ...(status === "failed" ? { outcomeWarning: "Tool may already have executed" } : {}),
          },
        } : {}),
      });
    }
  }

  private ensureAssistantMessage(state: ActiveTranscriptProjectionState, startTurn = false): string {
    if (startTurn && state.assistantTurnCompleted) {
      delete state.assistantMessageId;
      state.assistantTurnCompleted = false;
    }
    if (state.assistantMessageId) return state.assistantMessageId;
    const message = this.store.conversations.createMessage({
      sessionId: state.sessionId,
      role: "assistant",
      runId: state.runId,
      ...(state.requestConfiguration
        ? { metadata: { requestConfiguration: state.requestConfiguration } }
        : {}),
    });
    state.assistantMessageId = message.id;
    return message.id;
  }

  private projectUserInput(messageId: string, input: SessionInputRecord): void {
    if (input.content.trim().length > 0) {
      this.store.conversations.upsertMessagePart({
        sessionId: input.sessionId,
        messageId,
        type: "text",
        status: "completed",
        text: input.content,
        metadata: { items: input.items },
      });
    }
    for (const attachment of [...input.attachments].sort(
      (a, b) => a.seq - b.seq,
    )) {
      this.store.conversations.upsertMessagePart({
        sessionId: input.sessionId,
        messageId,
        type: "attachment",
        status: "completed",
        assetId: attachment.assetId,
        intent: attachment.intent,
        displayName: attachment.displayName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        metadata: { inputAttachmentId: attachment.id },
      });
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type GeneratedImageAssetMetadata = {
  assetId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
};

function generatedImageAssets(value: unknown): GeneratedImageAssetMetadata[] {
  if (!Array.isArray(value)) return [];
  const images: GeneratedImageAssetMetadata[] = [];
  for (const item of value) {
    const record = recordValue(item);
    const assetId = stringValue(record?.assetId);
    const displayName = stringValue(record?.displayName);
    const mediaType = stringValue(record?.mediaType);
    const sizeBytes = record?.sizeBytes;
    if (
      !assetId ||
      !displayName ||
      !mediaType?.startsWith("image/") ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      continue;
    }
    images.push({ assetId, displayName, mediaType, sizeBytes });
  }
  return images;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
