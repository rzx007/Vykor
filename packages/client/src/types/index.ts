/**
 * 客户端公开类型。
 *
 * 会话/事件/权限等记录类型来自 `@vykor/protocol`；本文件补充
 * HTTP 请求参数、响应体，以及 reducer 使用的本地聚合状态结构。
 */

import type { PluginInfo } from "./extension-types.js";
export type * from "./attachment-types.js";
export type * from "./extension-types.js";
export type * from "./sync-types.js";

import type {
  AdmitPromptAttachmentInput,
  AttachmentAssetRecord,
  CreateScheduledTaskInput,
  CreateNoteInput,
  CreateSessionInput,
  ForkSessionInput,
  InputDelivery,
  PermissionRequestRecord,
  NoteRecord,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
  UpdateNoteInput,
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
} from "@vykor/protocol";

export type {
  SessionGoal,
  CreateSessionGoalInput,
  UpdateSessionGoalInput,
  GoalActionInput,
  AdmitPromptAttachmentInput,
  AttachmentAssetRecord,
  CreateScheduledTaskInput,
  CreateNoteInput,
  InputDelivery,
  PermissionRequestRecord,
  NoteRecord,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
  UpdateNoteInput,
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

export interface ScheduledTaskStatusSummary {
  running: true;
  tasks: number;
  active: number;
  paused: number;
  executing: number;
  unread: number;
}

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

/** Wire-compatible copy of the daemon's aggregate MCP Runtime state. */
export type McpRuntimeStatus = "connected" | "disconnected" | "error" | "unavailable";

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}

export interface MemoryEntryRecord {
  id: string;
  content: string;
  tags?: string[];
  source?: {
    type: "user_message" | "manual_remember";
    sessionId?: string;
    messageSha256?: string;
  };
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
