/**
 * `closing` 表示 Session 正在停止当前工作并等待资源释放，此时不再接收新工作。
 * 等待结束后，Session 会进入不可逆的 archived 状态。
 */
export type SessionStatus =
  "idle" | "running" | "closing" | "archived" | "error";
export type InputDelivery = "queue" | "steer";
export type RunStatus =
  "pending" | "running" | "completed" | "failed" | "interrupted";
export type RunAttemptStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type SessionTaskStatus =
  "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export type PermissionStatus = "pending" | "approved" | "denied" | "expired";
export type SessionMessageRole = "system" | "user" | "assistant";
export type SessionMessagePartType =
  | "text"
  | "attachment"
  | "transformation"
  | "reasoning"
  | "tool"
  | "tool_result"
  | "error"
  | "log";
export type SessionMessagePartStatus =
  "pending" | "running" | "completed" | "failed" | "interrupted";
export type ProjectionSettlementAction = "retry-terminal-projection" | "compensate-child";
export type ProjectionSettlementStatus = "pending" | "retrying" | "resolved" | "abandoned";

/** Default durable session-event schema version for types without an override. */
export const SESSION_EVENT_SCHEMA_VERSION = 1;

/**
 * Per-event payload schema versions written by the durable event registry.
 * Unlisted types use {@link SESSION_EVENT_SCHEMA_VERSION}.
 */
export const SESSION_EVENT_SCHEMA_VERSIONS: Readonly<Record<string, number>> = {
  "session.input.admitted": 2,
};

export function sessionEventSchemaVersion(type: string): number {
  return SESSION_EVENT_SCHEMA_VERSIONS[type] ?? SESSION_EVENT_SCHEMA_VERSION;
}

export interface SessionRecord {
  id: string;
  parentId?: string;
  projectId?: string;
  cwd: string;
  cwdRelative?: string;
  title: string;
  model: string;
  agent?: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  pinnedAt?: number;
  defaultShell?: string;
  lastOpenedAt: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectLocationRecord {
  id: string;
  projectId: string;
  path: string;
  normalizedPath: string;
  status: "active" | "historical";
  boundAt: number;
  lastVerifiedAt?: number;
}

export interface SessionInputRecord {
  id: string;
  sessionId: string;
  seq: number;
  delivery: InputDelivery;
  items: SessionUserInputItem[];
  content: string;
  attachments: SessionInputAttachmentRecord[];
  promotedMessageId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: SessionMessageRole;
  runId?: string;
  inputId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessagePartRecord {
  id: string;
  sessionId: string;
  messageId: string;
  seq: number;
  type: SessionMessagePartType;
  status: SessionMessagePartStatus;
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
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEventRecord {
  id: string;
  seq: number;
  type: string;
  schemaVersion: number;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionAttachmentMessagePartRecord
  extends SessionMessagePartRecord {
  type: "attachment";
  assetId: string;
  intent: AttachmentIntent;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

export interface SessionTransformationMessagePartRecord
  extends SessionMessagePartRecord {
  type: "transformation";
  assetId: string;
  kind: "direct" | "document_extract" | "tool_mount";
  representationId?: string;
  processor?: string;
  transformationError?: string;
}

export interface ProjectionSettlementRecord {
  id: string;
  projector: string;
  rootSessionId: string;
  eventSequence: number;
  action: ProjectionSettlementAction;
  payload: Record<string, unknown>;
  status: ProjectionSettlementStatus;
  attemptCount: number;
  lastError?: string;
  nextRetryAt?: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export interface SessionRunRecord {
  id: string;
  sessionId: string;
  inputId?: string;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRunAttemptRecord {
  id: string;
  runId: string;
  sequence: number;
  status: RunAttemptStatus;
  provider?: string;
  model?: string;
  retryReason?: string;
  errorKind?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Model network retry projection (see docs/model-network-retry-design.md)
// ---------------------------------------------------------------------------

export type SessionModelFailureKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "stream_incomplete"
  | "authentication"
  | "invalid_request"
  | "quota"
  | "protocol"
  | "unknown";

const SESSION_MODEL_FAILURE_KINDS = new Set<string>([
  "network", "timeout", "rate_limit", "server", "stream_incomplete",
  "authentication", "invalid_request", "quota", "protocol", "unknown",
]);

/** Mirrors core `ModelRetryState` without creating a protocol -> core dependency. */
export interface SessionModelRetryState {
  generationId: string;
  attempt: number;
  retryNumber: number;
  maxRetries: number;
  reason: SessionModelFailureKind;
  nextRetryAt: number;
  recoveryDeadlineAt: number;
}

/** Stored on a message part to identify which model attempt produced it. */
export interface SessionModelGenerationMetadata {
  generationId: string;
  attempt: number;
  /** A newer attempt replaced this part; its content is diagnostic only. */
  superseded?: boolean;
  /** The generation completed successfully; only committed parts are valid history. */
  committed?: boolean;
}

export type SessionModelAttemptUsageStatus = "complete" | "partial" | "unknown";

export interface SessionModelAttemptUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  usageIncomplete?: boolean;
}

export interface SessionModelAttemptUsage {
  generationId: string;
  attempt: number;
  status: "completed" | "failed" | "interrupted";
  usageStatus: SessionModelAttemptUsageStatus;
  usage?: SessionModelAttemptUsageSnapshot;
}

export interface SessionModelUsageSummary {
  incomplete: boolean;
  unknownAttempts: number;
  partialAttempts: number;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 安全解析 Run metadata 中的重试状态；非法/未知数据返回 undefined。 */
export function readSessionModelRetryState(
  metadata: Record<string, unknown>,
): SessionModelRetryState | undefined {
  const raw = metadata.modelRetry;
  if (!isRecordValue(raw)) return undefined;
  const generationId = readNonEmptyString(raw.generationId);
  const attempt = readPositiveInteger(raw.attempt);
  const retryNumber = readPositiveInteger(raw.retryNumber);
  const maxRetries = readNonNegativeInteger(raw.maxRetries);
  const reason = readNonEmptyString(raw.reason);
  const nextRetryAt = readFiniteNumber(raw.nextRetryAt);
  const recoveryDeadlineAt = readFiniteNumber(raw.recoveryDeadlineAt);
  if (
    !generationId ||
    attempt === undefined ||
    retryNumber === undefined ||
    maxRetries === undefined ||
    !reason ||
    !SESSION_MODEL_FAILURE_KINDS.has(reason) ||
    nextRetryAt === undefined ||
    recoveryDeadlineAt === undefined
  ) {
    return undefined;
  }
  return {
    generationId,
    attempt,
    retryNumber,
    maxRetries,
    reason: reason as SessionModelFailureKind,
    nextRetryAt,
    recoveryDeadlineAt,
  };
}

/** 安全解析 part metadata 中的生成归属；非法数据返回 undefined。 */
export function readModelGenerationMetadata(
  metadata: Record<string, unknown>,
): SessionModelGenerationMetadata | undefined {
  const raw = metadata.modelGeneration;
  if (!isRecordValue(raw)) return undefined;
  const generationId = readNonEmptyString(raw.generationId);
  const attempt = readPositiveInteger(raw.attempt);
  if (!generationId || attempt === undefined) return undefined;
  return {
    generationId,
    attempt,
    ...(raw.superseded === true ? { superseded: true } : {}),
    ...(raw.committed === true ? { committed: true } : {}),
  };
}

/** 被新尝试替代的 part：界面和模型历史都不应把它当作有效内容。 */
export function isSupersededModelPart(part: SessionMessagePartRecord): boolean {
  return readModelGenerationMetadata(part.metadata)?.superseded === true;
}

/**
 * 可作为模型历史的已确认 part。旧格式（无 modelGeneration）保持原语义返回
 * true；新格式必须 committed=true 且未被替代。
 */
export function isCommittedModelPart(part: SessionMessagePartRecord): boolean {
  const generation = readModelGenerationMetadata(part.metadata);
  if (!generation) return true;
  return generation.committed === true && generation.superseded !== true;
}

export function readSessionModelUsage(
  metadata: Record<string, unknown>,
): SessionModelUsageSummary | undefined {
  const raw = metadata.modelUsage;
  if (!isRecordValue(raw)) return undefined;
  return {
    incomplete: raw.incomplete === true,
    unknownAttempts: readNonNegativeInteger(raw.unknownAttempts) ?? 0,
    partialAttempts: readNonNegativeInteger(raw.partialAttempts) ?? 0,
  };
}

export function readSessionModelAttemptUsage(
  value: unknown,
): SessionModelAttemptUsage | undefined {
  if (!isRecordValue(value)) return undefined;
  const generationId = readNonEmptyString(value.generationId);
  const attempt = readPositiveInteger(value.attempt);
  const status = value.status;
  const usageStatus = value.usageStatus;
  if (
    !generationId ||
    attempt === undefined ||
    (status !== "completed" && status !== "failed" && status !== "interrupted") ||
    (usageStatus !== "complete" && usageStatus !== "partial" && usageStatus !== "unknown")
  ) {
    return undefined;
  }
  let usage: SessionModelAttemptUsageSnapshot | undefined;
  if (isRecordValue(value.usage)) {
    const inputTokens = readNonNegativeInteger(value.usage.inputTokens);
    const outputTokens = readNonNegativeInteger(value.usage.outputTokens);
    if (inputTokens === undefined || outputTokens === undefined) return undefined;
    usage = {
      inputTokens,
      outputTokens,
      ...(readNonNegativeInteger(value.usage.cacheCreationTokens) !== undefined
        ? { cacheCreationTokens: readNonNegativeInteger(value.usage.cacheCreationTokens) } : {}),
      ...(readNonNegativeInteger(value.usage.cacheReadTokens) !== undefined
        ? { cacheReadTokens: readNonNegativeInteger(value.usage.cacheReadTokens) } : {}),
      ...(value.usage.usageIncomplete === true ? { usageIncomplete: true } : {}),
    };
  } else if (usageStatus === "complete") {
    // A complete settlement without a usage snapshot is invalid.
    return undefined;
  }
  return { generationId, attempt, status, usageStatus, ...(usage ? { usage } : {}) };
}

export interface SessionExecutionRecord {
  id: string;
  sessionId: string;
  /** Producer namespace plus requestId uniquely identify one logical admission. */
  requestNamespace?: string;
  requestId?: string;
  childSessionId?: string;
  runId?: string;
  type: string;
  status: SessionTaskStatus;
  description: string;
  cwd: string;
  output?: string;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface PermissionRequestRecord {
  id: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  payload: Record<string, unknown>;
  status: PermissionStatus;
  decision?: string;
  decidedByClientId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Atomic, server-owned state used when a client attaches to one session. */
export interface SessionStateSnapshot {
  cursor: number;
  session: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  runs: SessionRunRecord[];
  attempts: SessionRunAttemptRecord[];
  tasks?: SessionExecutionRecord[];
  permissions: PermissionRequestRecord[];
}

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskDestination = "standalone" | "chat";
export type ScheduledTaskExecutionMode = "local" | "worktree";
export type ScheduledRecurrenceFormat = "rrule" | "once";
export type ScheduledOverlapPolicy = "skip" | "queue";
export type ScheduledMissedRunPolicy = "skip" | "run_once";

export interface ScheduledPermissionProfile {
  mode: "read_only" | "workspace_write" | "full_access";
  network?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface ScheduledStopPolicy {
  runOnce?: boolean;
  maxRuns?: number;
  stopWhenCompleted?: boolean;
  expiresAt?: number;
}

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: ScheduledRecurrenceFormat;
  timezone: string;
  status: ScheduledTaskStatus;
  destination: ScheduledTaskDestination;
  sessionId?: string;
  projectPaths: string[];
  executionMode: ScheduledTaskExecutionMode;
  model?: string;
  effort?: string;
  skillNames: string[];
  pluginNames: string[];
  permissionProfile: ScheduledPermissionProfile;
  overlapPolicy: ScheduledOverlapPolicy;
  missedRunPolicy: ScheduledMissedRunPolicy;
  stopPolicy?: ScheduledStopPolicy;
  createdBy: "user" | "agent";
  createdFromSessionId?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export type ScheduledRunCause = "scheduled" | "manual" | "missed_run";
export type ScheduledRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "needs_attention"
  | "skipped";

export interface ScheduledRunRecord {
  id: string;
  taskId: string;
  cause: ScheduledRunCause;
  status: ScheduledRunStatus;
  scheduledFor: number;
  sessionId?: string;
  runId?: string;
  summary?: string;
  error?: string;
  unread: boolean;
  attentionReason?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface CreateScheduledTaskInput {
  id?: string;
  name: string;
  description?: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: ScheduledRecurrenceFormat;
  timezone: string;
  status?: ScheduledTaskStatus;
  destination: ScheduledTaskDestination;
  sessionId?: string;
  projectPaths?: string[];
  executionMode?: ScheduledTaskExecutionMode;
  model?: string;
  effort?: string;
  skillNames?: string[];
  pluginNames?: string[];
  permissionProfile?: ScheduledPermissionProfile;
  overlapPolicy?: ScheduledOverlapPolicy;
  missedRunPolicy?: ScheduledMissedRunPolicy;
  stopPolicy?: ScheduledStopPolicy;
  createdBy?: ScheduledTaskRecord["createdBy"];
  createdFromSessionId?: string;
  nextRunAt?: number;
}

export type UpdateScheduledTaskInput = Partial<
  Omit<CreateScheduledTaskInput, "id" | "nextRunAt">
> & {
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runCount?: number;
};

export interface CreateScheduledRunInput {
  id?: string;
  taskId: string;
  cause: ScheduledRunCause;
  scheduledFor: number;
}

export interface UpdateScheduledRunInput {
  status?: ScheduledRunStatus;
  sessionId?: string;
  runId?: string;
  summary?: string;
  error?: string;
  unread?: boolean;
  attentionReason?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface CreateSessionInput {
  id?: string;
  parentId?: string;
  projectId?: string;
  cwd: string;
  title?: string;
  model: string;
  agent?: string;
  metadata?: Record<string, unknown>;
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
import type {
  AttachmentIntent,
  SessionInputAttachmentRecord,
} from "./attachment.js";
import type { SessionUserInputItem } from "./session-input-items.js";
