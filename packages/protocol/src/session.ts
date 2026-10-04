/**
 * `closing` 表示 Session 正在停止当前工作并等待资源释放，此时不再接收新工作。
 * 等待结束后，Session 会进入不可逆的 archived 状态。
 */
export type SessionStatus =
  "idle" | "running" | "closing" | "archived" | "error";
export type SessionStorage = "sqlite" | "memory";
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
  storage?: SessionStorage;
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

export function getSessionStorage(session: Pick<SessionRecord, "storage"> | undefined): SessionStorage {
  return session?.storage ?? "sqlite";
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

import type {
  AttachmentIntent,
  SessionInputAttachmentRecord,
} from "./attachment.js";
import type { SessionUserInputItem } from "./session-input-items.js";

export * from "./session-model.js";
export * from "./scheduled.js";
export * from "./session-requests.js";
