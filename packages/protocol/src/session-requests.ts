import type {
  InputDelivery, PermissionStatus, ProjectionSettlementAction, ProjectionSettlementStatus,
  RunAttemptStatus, RunStatus, SessionMessagePartStatus, SessionMessagePartType,
  SessionMessageRole, SessionTaskStatus, SessionStorage,
} from "./session.js";
import type { AttachmentIntent } from "./attachment.js";
import type { SessionUserInputItem } from "./session-input-items.js";

export interface CreateSessionInput {
  id?: string;
  storage?: SessionStorage;
  parentId?: string;
  projectId?: string;
  cwd: string;
  title?: string;
  model: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkSessionInput {
  beforeMessageId?: string;
  afterMessageId?: string;
  storage?: SessionStorage;
}

export interface UpdateSessionInput {
  title?: string;
  model?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

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

export interface CreateProjectionSettlementInput {
  id?: string;
  projector: string;
  rootSessionId: string;
  eventSequence: number;
  action: ProjectionSettlementAction;
  payload: Record<string, unknown>;
  error?: string;
}

export interface ListProjectionSettlementsOptions {
  projector?: string;
  rootSessionId?: string;
  status?: ProjectionSettlementStatus | readonly ProjectionSettlementStatus[];
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

export interface CreateRunInput {
  id?: string;
  sessionId: string;
  inputId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRunInput {
  status?: RunStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunAttemptInput {
  id?: string;
  runId: string;
  sequence?: number;
  provider?: string;
  model?: string;
  retryReason?: string;
}

export interface UpdateRunAttemptInput {
  status?: RunAttemptStatus;
  errorKind?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CreateSessionTaskInput {
  id?: string;
  sessionId: string;
  childSessionId?: string;
  runId?: string;
  type: string;
  description: string;
  cwd: string;
  status?: SessionTaskStatus;
  requestNamespace?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateSessionTaskInput {
  status?: SessionTaskStatus;
  runId?: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePermissionRequestInput {
  id?: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  payload?: Record<string, unknown>;
}

export interface ReplyPermissionInput {
  requestId: string;
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: string;
  clientId?: string;
  answer?: string;
}

export interface ListPermissionRequestsOptions {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

export interface ListEventsOptions {
  afterSeq?: number;
  sessionId?: string;
  limit?: number;
}

export interface ListSessionsOptions {
  cwd?: string;
  includeArchived?: boolean;
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
