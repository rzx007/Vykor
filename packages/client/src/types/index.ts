/**
 * 客户端公开类型。
 *
 * 会话/事件/权限等记录类型来自 `@openharness/protocol`；本文件补充
 * HTTP 请求参数、响应体，以及 reducer 使用的本地聚合状态结构。
 */

import type {
  AdmitPromptAttachmentInput,
  AdmitPromptInput,
  AttachmentAssetRecord,
  CreateScheduledTaskInput,
  CreateSessionInput,
  InputDelivery,
  PermissionRequestRecord,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
  PermissionStatus,
  SessionEventRecord,
  SessionAttachmentMessagePartRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
  SessionStateSnapshot,
  SessionTransformationMessagePartRecord,
  SessionUserInputItem,
  ListMessagePartsOptions,
  JobSnapshot,
  SessionGoal,
  CreateSessionGoalInput,
  UpdateSessionGoalInput,
  GoalActionInput,
} from "@openharness/protocol";

export type {
  SessionGoal,
  CreateSessionGoalInput,
  UpdateSessionGoalInput,
  GoalActionInput,
  AdmitPromptAttachmentInput,
  AttachmentAssetRecord,
  CreateScheduledTaskInput,
  InputDelivery,
  PermissionRequestRecord,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
  PermissionStatus,
  SessionEventRecord,
  SessionAttachmentMessagePartRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
  SessionStateSnapshot,
  SessionTransformationMessagePartRecord,
  SessionUserInputItem,
  ListMessagePartsOptions,
};

export interface UploadAttachmentInput {
  displayName: string;
  mediaType?: string;
  body: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface DownloadAttachmentOptions {
  range?: {
    start?: number;
    end?: number;
    suffixBytes?: number;
  };
  signal?: AbortSignal;
}

export interface AttachmentStorageIssue {
  code:
    | "missing_blob"
    | "size_mismatch"
    | "orphan_blob"
    | "stale_lease"
    | "deleted_asset_retained";
  severity: "warning" | "error";
  assetId?: string;
  sha256?: string;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  collectible?: boolean;
}

export interface AttachmentStorageReport {
  summary: {
    assets: Record<"importing" | "ready" | "failed" | "deleted", number>;
    uniqueBlobs: number;
    physicalBytes: number;
    logicalBytes: number;
    deduplicatedBytes: number;
    activeLeases: number;
    expiredLeases: number;
    reclaimableBytes: number;
  };
  issues: AttachmentStorageIssue[];
  latestGcAudit?: {
    id: string;
    policy: string;
    result: unknown;
    createdAt: number;
  };
}

export interface AttachmentStorageRepairResult {
  expiredLeases: number;
  deletedOrphanBlobs: number;
  releasedBytes: number;
}

export interface AttachmentStorageGcResult {
  scannedAssets: number;
  expiredLeases: number;
  deletedAssets: number;
  deletedBlobs: number;
  releasedBytes: number;
  skipped: Record<
    | "notDeleted"
    | "gracePeriod"
    | "missingHash"
    | "referenced"
    | "activeLease"
    | "sharedBlob",
    number
  >;
  errors: Array<{ assetId: string; code: "blob_delete_failed" }>;
}

export interface ScheduledTaskStatusSummary {
  running: true;
  tasks: number;
  active: number;
  paused: number;
  executing: number;
  unread: number;
}

/** `OpenHarnessClient` 构造参数。 */
export interface OpenHarnessClientOptions {
  /** daemon HTTP 根地址，例如 `http://127.0.0.1:8787`。 */
  baseUrl: string;
  /** Bearer token；与 daemon registry 中的 token 对应。 */
  token?: string;
  /** 可注入的 fetch，便于测试或自定义传输。 */
  fetch?: typeof fetch;
}

export interface OpenHarnessServerHealth {
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

export interface ForkClientSessionInput {
  beforeMessageId?: string;
  afterMessageId?: string;
}

export interface EditLatestClientPromptInput {
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
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

/** `POST /sessions/:id/runs/:runId/resume` 请求体。`id` 用于安全重试。 */
export interface ResumeInterruptedRunInput {
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
  cursor?: number;
  afterSeq?: number;
  messageId?: string;
  limit?: number;
}

/** `GET /events` 查询参数。 */
export interface ListEventsOptions {
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

export type CommandKind = "session" | "template";
export type CommandSelection = "execute" | "submenu" | "insert";
export type CommandSource =
  "builtin" | "bundled" | "user" | "plugin" | "project";

/** `GET /commands` 返回的命令元数据。 */
interface CommandCatalogEntryBase {
  name: string;
  displayName?: string;
  description?: string;
  source?: CommandSource;
  argumentHint?: string;
  selection?: CommandSelection;
  requiresEmptyComposer?: boolean;
}

export type CommandCatalogEntry = CommandCatalogEntryBase & (
  | { kind: "session"; path?: never; skillName?: never }
  | { kind: "template"; path: string; skillName: string }
);

/** `GET /commands` 查询参数。 */
export interface ListCommandsOptions {
  cwd: string;
}

/** `PATCH /sessions/:id` 请求体。 */
export interface UpdateClientSessionInput {
  title?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
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

export interface ListProjectsOptions {
  includeArchived?: boolean;
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
  custom?: boolean;
  requiresApiKey?: boolean;
  source?: "builtin" | "catalog" | "custom" | "subscription";
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  apiKey?: string;
  models: Array<{
    id: string;
    displayName: string;
    imageInputSupport?: "native" | "unsupported" | "unknown";
  }>;
  headers?: Record<string, string>;
}

export interface ConnectCatalogProviderInput {
  apiKey: string;
  headers?: Record<string, string>;
}

export interface UpdateCatalogProviderHeadersInput {
  headers: Record<string, string>;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  providerName: string;
  hint?: string;
  contextWindow?: number;
  outputLimit?: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  vision?: boolean;
  inputModalities?: string[];
  inputCapabilities?: { image: "native" | "unsupported" | "unknown" };
  toolCalling?: boolean;
  status?: "active" | "beta";
}

export interface ModelProviderInfo {
  name: string;
  displayName: string;
  models: ModelInfo[];
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount: number;
  command?: string;
  error?: string;
}

export interface MemoryEntryRecord {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryListResponse {
  directory: string;
  entries: MemoryEntryRecord[];
}

export interface AuthStatus {
  codex: {
    configured: boolean;
    state: string;
    source: string;
    detail?: string;
    profileLabel?: string;
  };
  storedProviders: string[];
  envProviders: Array<{ name: string; envKey: string }>;
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

export interface ReloadPluginsResponse {
  plugins: PluginInfo[];
  warnings: string[];
  message: string;
}

export interface RememberSessionResponse {
  skipped: boolean;
  reason?: string;
  writtenIds: string[];
  titles: string[];
}

export interface StartDreamResponse {
  taskId: string;
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

export interface OutputStyleInfo {
  name: string;
  content: string;
  source: "builtin" | "user";
}

export type PluginRuntimeStatus =
  | { state: "disabled"; message: string; action: "enable" }
  | { state: "pending_reload"; message: string; action: "reload" }
  | { state: "loaded"; message: string; action: "none" }
  | {
      state: "degraded";
      code: string;
      message: string;
      action: "details" | "reimport" | "approve" | "disable";
    }
  | {
      state: "failed";
      code: string;
      message: string;
      action: "reimport" | "approve" | "disable" | "uninstall";
    };

export interface PluginInfo {
  identity: { id: string; name: string; version: string; displayName?: string };
  origin: "native" | "converted";
  sourceFormat?: string;
  scope: "user" | "managed";
  enabled: boolean;
  installation: "installed" | "missing" | "invalid";
  activation: "inactive" | "active" | "partial" | "reload-required";
  /** Installed-state view. Live Tool Host state belongs to the owning Agent runtime. */
  toolRuntime?: {
    state:
      | "inactive"
      | "reload-required"
      | "starting"
      | "active"
      | "degraded"
      | "error";
    declaredEntries: number;
    activatableEntries: number;
    hostCount: number;
    registeredToolCount: number;
    lastStartedAt?: string;
    lastError?: string;
  };
  runtimeStatus: PluginRuntimeStatus;
  inventory: Record<string, number>;
  permissions: { requested: string[]; approved: string[]; missing: string[] };
  diagnostics: Array<{
    severity: "info" | "warning" | "error";
    phase: string;
    code: string;
    message: string;
    path?: string;
  }>;
}

export interface PluginArchivePreview {
  archiveDigest: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginGitPreview {
  sourceDigest: string;
  url: string;
  ref?: string;
  commit: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginArchiveError {
  code: string;
  message: string;
  diagnostics?: PluginInfo["diagnostics"];
}

export type SkillSource = "bundled" | "agent" | "project" | "personal" | "standard";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  content: string;
  path: string;
  source: SkillSource;
  readOnly: boolean;
  projectPath?: string;
  projectName?: string;
}

export interface SkillProject {
  name: string;
  path: string;
}

export interface SkillSnapshot {
  skills: SkillInfo[];
  projects: SkillProject[];
  warnings: string[];
}

export interface AgentPersonaInfo {
  name: string;
  description: string;
  source?: string;
  model?: string;
}

export interface HookInfo {
  id: string;
  event: string;
  type: string;
  enabled: boolean;
  origin: "settings" | "runtime";
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

/**
 * 单个 session 在客户端的聚合视图。
 * 由事件 reducer 从 event log 归并得出，不是服务端直接返回的结构。
 */
export interface SessionBucket {
  session?: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  partsByMessageId: Record<string, SessionMessagePartRecord[]>;
  runs: Record<string, SessionRunRecord>;
  attempts: Record<string, SessionRunAttemptRecord>;
  tasks: Record<string, SessionExecutionRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

/**
 * 客户端权威状态：由 snapshot/live（或全局 replay/live）经 reducer 收敛。
 * 多端 attach 同一 daemon 时，应得到一致的状态形状。
 */
export interface OpenHarnessClientState {
  sessions: Record<string, SessionRecord>;
  /** 按 `updatedAt` 降序的 session id 列表。 */
  sessionOrder: string[];
  buckets: Record<string, SessionBucket>;
  /** Durable replay events indexed by seq; live text deltas are not retained. */
  eventsBySeq: Record<number, SessionEventRecord>;
  /** Latest atomic snapshot cursor for each session; older delayed SSE events are ignored. */
  snapshotCursorBySession: Record<string, number>;
  /** Highest ordered transient event seq already applied; prevents SSE reconnect replay. */
  transientCursor: number;
  /** 当前已应用到的最大事件序号，用作 SSE cursor。 */
  lastSeq: number;
}

/** `syncEvents` / `streamEvents` 的过滤与取消选项。 */
export interface EventSyncOptions {
  sessionId?: string;
  cursor?: number;
  signal?: AbortSignal;
  /**
   * Delay before a live-stream reconnect attempt (attempt is 0-based).
   * Defaults to exponential backoff capped at 30s. Tests may pass `() => 0`.
   */
  reconnectDelayMs?: (attempt: number) => number;
  /** 会话事件流空闲超时（毫秒）；默认由 sync 层填 60s。 */
  idleTimeoutMs?: number;
}

/** `syncEvents` 产出的单次状态更新。 */
export interface SyncEventUpdate {
  event?: SessionEventRecord;
  state: OpenHarnessClientState;
  /** Session attach starts from an atomic snapshot, then consumes SSE deltas. */
  source: "snapshot" | "replay" | "live" | "reconnecting";
}

/** 去掉 sessionId 后的 admit prompt 输入（sessionId 由路径提供）。 */
export type PromptInputForClient = Omit<AdmitPromptInput, "sessionId">;
