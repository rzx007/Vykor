/** Public Agent lifecycle request, response and synchronization types. */
import type { AdmitPromptAttachmentInput, AttachmentAssetRecord, CreateSessionInput, ForkSessionInput, InputDelivery, PermissionRequestRecord, PermissionStatus, SessionEventRecord, SessionAttachmentMessagePartRecord, SessionInputAttachmentRecord, SessionInputRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRecord, SessionRunRecord, SessionRunAttemptRecord, SessionExecutionRecord, AgentSessionStateSnapshot as SessionStateSnapshot, SessionTransformationMessagePartRecord, SessionUserInputItem, ListMessagePartsOptions, JobSnapshot, SessionGoal, CreateSessionGoalInput, UpdateSessionGoalInput, GoalActionInput } from "@vykor/protocol";
export type { AdmitPromptAttachmentInput, AttachmentAssetRecord, InputDelivery, PermissionRequestRecord, PermissionStatus, SessionEventRecord, SessionAttachmentMessagePartRecord, SessionInputAttachmentRecord, SessionInputRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRecord, SessionRunRecord, SessionRunAttemptRecord, SessionExecutionRecord, AgentSessionStateSnapshot as SessionStateSnapshot, SessionTransformationMessagePartRecord, SessionUserInputItem, ListMessagePartsOptions, JobSnapshot, SessionGoal, CreateSessionGoalInput, UpdateSessionGoalInput, GoalActionInput } from "@vykor/protocol";
export type { GoalStopReason, GoalExternalWait } from "@vykor/protocol";
export type * from "./attachment-types.js";
export type * from "./runtime-types.js";
export type * from "./sync-types.js";

/** `VykorClient` 构造参数。 */
export interface VykorClientOptions {
  /** daemon HTTP 根地址，例如 `http://127.0.0.1:8787`。 */
  baseUrl: string;
  /** Bearer token；与 daemon registry 中的 token 对应。 */
  token?: string;
  /** 可注入的 fetch，便于测试或自定义传输。 */
  fetch?: typeof fetch;
}

export interface VykorServerHealth {
  ok: true;
  version?: string;
  startedAt: number;
  uptimeMs: number;
  sessionCount: number;
  activeRunCount: number;
  queuedRunCount: number;
}

/** `GET /sessions` 查询参数。 */
export interface ListSessionsOptions {
  cwd?: string;
  includeArchived?: boolean;
  includeChildren?: boolean;
  limit?: number;
}

/** `POST /sessions` 请求体。 */
export type CreateClientSessionInput = CreateSessionInput;

export type ForkClientSessionInput = ForkSessionInput;

export interface EditLatestClientPromptInput {
  outputSchema?: Record<string, unknown>;
  id: string;
  items: SessionUserInputItem[];
  sourceMessageId: string;
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface PromoteQueuedClientPromptInput {
  queuedRunId: string;
  expectedActiveRunId: string;
}

export interface CancelQueuedClientPromptInput {
  queuedRunId: string;
}

export interface PromoteQueuedPromptResponse {
  input: SessionInputRecord;
  queued_run: SessionRunRecord;
  active_run: SessionRunRecord;
}

export interface CancelQueuedPromptResponse {
  input: SessionInputRecord;
  run: SessionRunRecord;
}

/** `POST /sessions/:id/prompts` 请求体。 */
export interface AdmitClientPromptInput {
  id?: string;
  items: SessionUserInputItem[];
  delivery?: InputDelivery;
  outputSchema?: Record<string, unknown>;
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

/** Session identity is carried by the URL; only lifecycle prompt fields are public. */
export type PromptInputForClient = AdmitClientPromptInput;

/** `POST /sessions/:id/runs/:runId/resume` 请求体。`id` 用于安全重试。 */
export interface ResumeInterruptedRunInput {
  /** If supplied, must equal the original prompt's contract. */
  outputSchema?: Record<string, unknown>;
  id?: string;
  metadata?: Record<string, unknown>;
}

/** `GET /sessions/:id/messages` 查询参数。 */
export interface ListMessagesOptions {
  cursor?: number;
  afterSeq?: number;
  limit?: number;
}

/** `GET /sessions/:id/parts` 查询参数。 */
export interface ListClientMessagePartsOptions {
  partView?: "summary";
  cursor?: number;
  afterSeq?: number;
  messageId?: string;
  limit?: number;
}

/** `GET /events` 查询参数。 */
export interface ListEventsOptions {
  partView?: "summary";
  cursor?: number;
  afterSeq?: number;
  sessionId?: string;
  limit?: number;
}

/** `GET /permissions` 查询参数。 */
export interface ListPermissionsOptions {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

/** `POST /permissions/:id/reply` 请求体。 */
export interface ReplyPermissionInput {
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: "once" | "session";
  clientId?: string;
}

/** `POST /sessions/:id/prompts` 响应。 */
export interface PromptResponse {
  input: SessionInputRecord;
  run?: SessionRunRecord;
  queue_state?: "running" | "queued";
}

/** `POST /sessions/:id/runs/:runId/resume` 响应。旧 run 保持 interrupted，新 run 独立执行。 */
export interface ResumeInterruptedRunResponse extends PromptResponse {
  source_run: SessionRunRecord;
}

/** `PATCH /sessions/:id` 请求体。 */
export interface UpdateClientSessionInput {
  title?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CompactSessionResponse {
  messageCount: number;
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
}

export interface RewindSessionResponse {
  turns: number;
  removed: number;
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
}

export interface RememberSessionResponse {
  skipped: boolean;
  reason?: string;
  writtenIds: string[];
  titles: string[];
}

export interface SessionUsageResponse {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  messageCount: number;
  estimatedCost: string;
}

export interface SessionExportResponse {
  format: "md" | "json";
  filepath: string;
  messageCount: number;
}

/** `POST /background-shells` 请求体。 */
export interface CreateBackgroundShellInput {
  /** Stable caller identity for safe retries of one logical creation request. */
  requestId?: string;
  sessionId: string;
  command: string;
  cwd?: string;
  description?: string;
}

/** `POST /background-shells` 响应。 */
export interface CreateBackgroundShellResult {
  jobId: string;
  snapshot: JobSnapshot;
}

/** `POST /sessions/:id/interrupt` 响应。 */
export interface InterruptSessionResponse {
  activeRunId?: string;
  queuedRunIds: string[];
  interrupted: boolean;
}
