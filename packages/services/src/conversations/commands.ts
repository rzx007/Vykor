import type { InputDelivery, SessionMessagePartStatus, SessionMessagePartType, SessionMessageRole } from "@vykor/domain-contracts/sessions";
import type { AttachmentIntent } from "@vykor/domain-contracts/attachments";
import type { SessionUserInputItem } from "@vykor/domain-contracts/inputs";
export interface AdmitPromptInput {
  id?: string;
  sessionId: string;
  delivery?: InputDelivery;
  items: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface AdmitPromptAttachmentInput {
  assetId: string;
  intent?: AttachmentIntent;
  displayName?: string;
}

export interface AdmitPromptWithRunInput {
  prompt: AdmitPromptInput;
  run?: {
    id?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface CreateMessageInput {
  id?: string;
  sessionId: string;
  role: SessionMessageRole;
  runId?: string;
  inputId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceTranscriptPartInput {
  type: SessionMessagePartType;
  status?: SessionMessagePartStatus;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  assetId?: string;
  intent?: AttachmentIntent;
  displayName?: string;
  mediaType?: string;
  sizeBytes?: number;
  kind?: "direct" | "document_extract" | "tool_mount";
  representationId?: string;
  processor?: string;
  transformationError?: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceTranscriptMessageInput {
  role: SessionMessageRole;
  parts: ReplaceTranscriptPartInput[];
  metadata?: Record<string, unknown>;
}

export interface ReplaceTranscriptInput {
  sessionId: string;
  messages: ReplaceTranscriptMessageInput[];
}

export interface UpsertMessagePartInput {
  id?: string;
  sessionId: string;
  messageId: string;
  type: SessionMessagePartType;
  status?: SessionMessagePartStatus;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  assetId?: string;
  intent?: AttachmentIntent;
  displayName?: string;
  mediaType?: string;
  sizeBytes?: number;
  kind?: "direct" | "document_extract" | "tool_mount";
  representationId?: string;
  processor?: string;
  transformationError?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendMessagePartDeltaInput {
  sessionId: string;
  messageId: string;
  partId: string;
  /** 增量写入的字段；reasoning 用于模型的思考内容。 */
  field: "text" | "reasoning";
  delta: string;
}

export interface AppendEventInput {
  id?: string;
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface ListEventsOptions {
  afterSeq?: number;
  sessionId?: string;
  limit?: number;
}

export interface ListMessagesOptions {
  afterSeq?: number;
  limit?: number;
}

export interface ListMessagePartsOptions {
  afterSeq?: number;
  messageId?: string;
  limit?: number;
}
