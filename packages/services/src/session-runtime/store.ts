import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeSessionUserInputItems,
  parseAttachmentAssetRecord,
  parseAttachmentLimits,
  sessionUserInputText,
} from "@openharness/protocol";

import type {
  AdmitPromptInput,
  AdmitPromptWithRunInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateProjectionSettlementInput,
  CreateScheduledRunInput,
  CreateScheduledTaskInput,
  CreateRunInput,
  CreateRunAttemptInput,
  CreateSessionTaskInput,
  CreateSessionInput,
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  ListPermissionRequestsOptions,
  ListProjectionSettlementsOptions,
  ListSessionsOptions,
  PermissionRequestRecord,
  ProjectionSettlementRecord,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  ProjectRecord,
  ReplyPermissionInput,
  SessionMessagePartRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
  SessionStateSnapshot,
  UpsertMessagePartInput,
  UpdateScheduledRunInput,
  UpdateScheduledTaskInput,
  UpdateRunInput,
  UpdateRunAttemptInput,
  UpdateSessionTaskInput,
  UpdateSessionInput,
  ReplaceTranscriptInput,
  ExternalConversationRecord,
  ChannelDeliveryRecord,
  ChannelDeliveryStatus,
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
  AttachmentLimits,
  SessionInputAttachmentRecord,
  SessionUserInputItem,
  SessionGoal,
  GoalStatus,
  GoalWait,
  GoalAssessment,
} from "@openharness/protocol";
import { AttachmentError } from "../attachment/attachment-errors.js";
import { SessionDatabase } from "../database/session-database.js";
import {
  cloneMutationBuffer,
  createMutationBuffer,
} from "../database/mutation-buffer.js";
import { formatSessionTitle, isPlaceholderSessionTitle } from "./title.js";
import {
  defaultDurableEventRegistry,
  type DurableEventRegistry,
} from "./event-registry.js";

export interface CreateAttachmentRepresentationInput {
  id: string;
  assetId: string;
  kind: AttachmentRepresentationKind;
  processor: string;
  processorVersion: string;
  cacheKey: string;
  mediaType: string;
  createdAt?: number;
}

type StoreAdmitPromptInput = Omit<AdmitPromptInput, "content" | "items"> & {
  content?: string;
  items?: readonly SessionUserInputItem[];
};

export interface AttachmentLeaseRecord {
  id: string;
  assetId: string;
  ownerKind: "session_run" | "backup";
  ownerId: string;
  createdAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface AcquireAttachmentLeasesInput {
  assetIds: string[];
  ownerKind: AttachmentLeaseRecord["ownerKind"];
  ownerId: string;
  timestamp: number;
  expiresAt: number;
}

import {
  DEFAULT_DELTA_FLUSH_BYTES,
  DEFAULT_DELTA_FLUSH_INTERVAL_MS,
  EVENT_SEQUENCE_BLOCK_SIZE,
  assertMessage,
  assertMutableSession,
  assertSession,
  clone,
  decode,
  emptyState,
  encode,
  isDurableEvent,
  isTerminalRunStatus,
  maxSeq,
  now,
  scheduledRunFromRow,
  scheduledTaskFromRow,
  type SessionStoreOptions,
  type SessionState,
} from "./store-state.js";
import {
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  uniqueReferencedBytes,
} from "./prompt-attachments.js";

export type { SessionStoreOptions } from "./store-state.js";

export interface StoredWorkflowRunInput {
  runId: string;
  ownerSessionId?: string;
  ownerInputId?: string;
  ownerRunId?: string;
  status: string;
  termination?: string;
  snapshotJson: string;
  createdAt: number;
  updatedAt: number;
  taskAttempts: Array<{
    taskId: string;
    attempt: number;
    status: string;
    payloadJson: string;
    startedAt: number;
    finishedAt?: number;
  }>;
}

export interface StoredWorkflowRunRecord extends Omit<
  StoredWorkflowRunInput,
  "taskAttempts"
> {}

export interface ApplicationOwnerLease {
  ownerId: string;
  pid: number;
  generation: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface CreateImportingAttachmentInput {
  id: string;
  displayName: string;
  declaredMediaType?: string;
  stagingName: string;
  createdAt?: number;
}

export interface MarkAttachmentReadyInput {
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  updatedAt?: number;
}

export interface CreateSessionGoalStoreInput {
  id?: string;
  sessionId: string;
  objective: string;
  pluginId?: string;
  maxAutoTurns: number;
}

export interface UpdateSessionGoalStoreInput {
  expectedRevision: number;
  objective?: string;
  pluginId?: string;
  status?: GoalStatus;
  maxAutoTurns?: number;
  autoTurnsUsed?: number;
  noProgressCount?: number;
  blockerKey?: string | null;
  currentRunId?: string | null;
  reason?: string | null;
  wait?: GoalWait | null;
  evidence?: string[];
  assessment?: GoalAssessment | null;
}

export interface SessionGoalRequestRecord {
  requestId: string;
  sessionId: string;
  fingerprint: string;
  status: "pending" | "completed" | "failed";
  goalId?: string;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImportingAttachmentRecord extends AttachmentAssetRecord {
  stagingName: string;
}

export class ApplicationOwnerConflictError extends Error {
  constructor(readonly activeOwner: ApplicationOwnerLease) {
    super(
      `Data directory is already owned by ${activeOwner.ownerId} (pid ${activeOwner.pid}, generation ${activeOwner.generation})`,
    );
    this.name = "ApplicationOwnerConflictError";
  }
}

function sessionGoalFromRow(row: Record<string, unknown>): SessionGoal {
  const wait =
    typeof row.wait_json === "string"
      ? (JSON.parse(row.wait_json) as GoalWait)
      : undefined;
  const evidence =
    typeof row.evidence_json === "string"
      ? (JSON.parse(row.evidence_json) as string[])
      : [];
  const assessment =
    typeof row.last_assessment_json === "string"
      ? (JSON.parse(row.last_assessment_json) as GoalAssessment)
      : undefined;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    objective: String(row.objective),
    ...(typeof row.plugin_id === "string" ? { pluginId: row.plugin_id } : {}),
    revision: Number(row.revision),
    status: String(row.status) as GoalStatus,
    maxAutoTurns: Number(row.max_auto_turns),
    autoTurnsUsed: Number(row.auto_turns_used),
    noProgressCount: Number(row.no_progress_count),
    ...(typeof row.blocker_key === "string"
      ? { blockerKey: row.blocker_key }
      : {}),
    ...(typeof row.current_run_id === "string"
      ? { currentRunId: row.current_run_id }
      : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(wait ? { wait } : {}),
    evidence,
    ...(assessment ? { assessment } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface RetentionPolicy {
  durableEventMaxAgeMs: number;
  workflowEventMaxAgeMs: number;
  workflowRunMaxAgeMs: number;
  runAttemptMaxAgeMs: number;
  projectionSettlementMaxAgeMs: number;
  completedJobVisibleForMs: number;
  terminalOutputMaxBytes: number;
  attachmentGracePeriodMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  durableEventMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  workflowEventMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  workflowRunMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  runAttemptMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  projectionSettlementMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  completedJobVisibleForMs: 7 * 24 * 60 * 60 * 1_000,
  terminalOutputMaxBytes: 10 * 1024 * 1024,
  attachmentGracePeriodMs: 7 * 24 * 60 * 60 * 1_000,
};

export class SessionStore {
  readonly path: string;
  private readonly databaseKernel: SessionDatabase;
  private readonly database: Database.Database;
  private closed = false;
  private transactionDepth = 0;
  private saveRequested = false;
  private readonly deltaFlushIntervalMs: number;
  private readonly deltaFlushBytes: number;
  private readonly eventRegistry: DurableEventRegistry;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly dirtyDeltaPartIds = new Set<string>();
  private pendingDeltaBytes = 0;
  private deltaFlushTimer?: ReturnType<typeof setTimeout>;
  private reservedEventSeq = 0;
  private mutations = createMutationBuffer();
  private state: SessionState;
  private readonly taskListeners = new Map<string, Set<() => void>>();
  private activeOwnerLease?: ApplicationOwnerLease;

  constructor(options: SessionStoreOptions) {
    this.databaseKernel = SessionDatabase.open({ path: options.path });
    this.path = this.databaseKernel.path;
    this.deltaFlushIntervalMs = Math.max(
      1,
      options.deltaFlushIntervalMs ?? DEFAULT_DELTA_FLUSH_INTERVAL_MS,
    );
    this.deltaFlushBytes = Math.max(
      1,
      options.deltaFlushBytes ?? DEFAULT_DELTA_FLUSH_BYTES,
    );
    this.eventRegistry = options.eventRegistry ?? defaultDurableEventRegistry;
    this.attachmentLimits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.attachmentLimits,
    });
    this.database = this.databaseKernel.connection;
    try {
      this.state = this.load();
    } catch (error) {
      this.databaseKernel.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flushMessagePartDeltas();
    } finally {
      this.clearDeltaFlushTimer();
      this.databaseKernel.close();
      this.closed = true;
    }
  }

  createImportingAttachment(
    input: CreateImportingAttachmentInput,
  ): AttachmentAssetRecord {
    const timestamp = input.createdAt ?? now();
    parseAttachmentAssetRecord({
      id: input.id,
      displayName: input.displayName,
      ...(input.declaredMediaType
        ? { declaredMediaType: input.declaredMediaType }
        : {}),
      status: "importing",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.database
      .prepare(
        `INSERT INTO attachment_asset (
          id, display_name, declared_media_type, status, staging_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'importing', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.displayName,
        input.declaredMediaType ?? null,
        input.stagingName,
        timestamp,
        timestamp,
      );
    return this.getAttachment(input.id, { includeDeleted: true })!;
  }

  markAttachmentReady(
    id: string,
    input: MarkAttachmentReadyInput,
  ): AttachmentAssetRecord {
    const current = this.attachmentForTransition(id, "importing");
    const updatedAt = input.updatedAt ?? now();
    parseAttachmentAssetRecord({
      ...current,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      mediaType: input.mediaType,
      status: "ready",
      updatedAt,
    });
    const result = this.database
      .prepare(
        `UPDATE attachment_asset
         SET sha256 = ?, size_bytes = ?, media_type = ?, status = 'ready',
             staging_name = NULL, failure_code = NULL, updated_at = ?
         WHERE id = ? AND status = 'importing'`,
      )
      .run(input.sha256, input.sizeBytes, input.mediaType, updatedAt, id);
    if (result.changes !== 1) {
      throw this.attachmentTransitionError(id, "importing");
    }
    return this.getAttachment(id, { includeDeleted: true })!;
  }

  failAttachmentImport(
    id: string,
    failureCode: string,
    updatedAt = now(),
  ): AttachmentAssetRecord {
    const current = this.attachmentForTransition(id, "importing");
    parseAttachmentAssetRecord({
      ...current,
      status: "failed",
      failureCode,
      updatedAt,
    });
    const result = this.database
      .prepare(
        `UPDATE attachment_asset
         SET status = 'failed', staging_name = NULL, failure_code = ?,
             updated_at = ?
         WHERE id = ? AND status = 'importing'`,
      )
      .run(failureCode, updatedAt, id);
    if (result.changes !== 1) {
      throw this.attachmentTransitionError(id, "importing");
    }
    return this.getAttachment(id, { includeDeleted: true })!;
  }

  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_asset WHERE id = ?${options.includeDeleted ? "" : " AND status != 'deleted'"}`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_asset
         WHERE sha256 = ? AND status = 'ready'
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(sha256) as Record<string, unknown> | undefined;
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  listAttachments(
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_asset${options.includeDeleted ? "" : " WHERE status != 'deleted'"} ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(attachmentAssetFromRow);
  }

  listImportingAttachments(): ImportingAttachmentRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_asset
         WHERE status = 'importing'
         ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...attachmentAssetFromRow(row),
      stagingName: String(row.staging_name),
    }));
  }

  createAttachmentRepresentation(
    input: CreateAttachmentRepresentationInput,
  ): AttachmentRepresentationRecord {
    const createdAt = input.createdAt ?? now();
    this.database
      .prepare(
        `INSERT INTO attachment_representation (
        id, asset_id, kind, status, processor, processor_version, cache_key,
        media_type, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        input.id,
        input.assetId,
        input.kind,
        input.processor,
        input.processorVersion,
        input.cacheKey,
        input.mediaType,
        createdAt,
        createdAt,
      );
    return this.getAttachmentRepresentation(input.id)!;
  }

  getAttachmentRepresentation(
    id: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM attachment_representation WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  listAttachmentRepresentations(
    assetId: string,
  ): AttachmentRepresentationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_representation
       WHERE asset_id = ?
       ORDER BY created_at, id`,
      )
      .all(assetId) as Array<Record<string, unknown>>;
    return rows.map(attachmentRepresentationFromRow);
  }

  acquireAttachmentLeases(
    input: AcquireAttachmentLeasesInput,
  ): AttachmentLeaseRecord[] {
    validateLeaseWindow(input.timestamp, input.expiresAt);
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length === 0) return [];
    return this.database
      .transaction(() => {
        for (const assetId of assetIds) {
          const asset = this.getAttachment(assetId);
          if (asset?.status !== "ready") {
            throw new AttachmentError(
              "attachment_not_ready",
              `Attachment is not ready: ${assetId}`,
            );
          }
        }
        const upsert = this.database.prepare(
          `INSERT INTO attachment_lease (
          id, asset_id, owner_kind, owner_id, created_at, renewed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, owner_kind, owner_id) DO UPDATE SET
          renewed_at = excluded.renewed_at,
          expires_at = excluded.expires_at`,
        );
        const find = this.database.prepare(
          `SELECT * FROM attachment_lease
         WHERE asset_id = ? AND owner_kind = ? AND owner_id = ?`,
        );
        return assetIds.map((assetId) => {
          upsert.run(
            randomUUID(),
            assetId,
            input.ownerKind,
            input.ownerId,
            input.timestamp,
            input.timestamp,
            input.expiresAt,
          );
          return attachmentLeaseFromRow(
            find.get(assetId, input.ownerKind, input.ownerId) as Record<
              string,
              unknown
            >,
          );
        });
      })
      .immediate();
  }

  renewAttachmentLeases(input: {
    ownerKind: AttachmentLeaseRecord["ownerKind"];
    ownerId: string;
    timestamp: number;
    expiresAt: number;
  }): number {
    validateLeaseWindow(input.timestamp, input.expiresAt);
    return this.database
      .prepare(
        `UPDATE attachment_lease
       SET renewed_at = ?, expires_at = ?
       WHERE owner_kind = ? AND owner_id = ? AND expires_at > ?`,
      )
      .run(
        input.timestamp,
        input.expiresAt,
        input.ownerKind,
        input.ownerId,
        input.timestamp,
      ).changes;
  }

  releaseAttachmentLeases(
    ownerKind: AttachmentLeaseRecord["ownerKind"],
    ownerId: string,
  ): number {
    return this.database
      .prepare(
        "DELETE FROM attachment_lease WHERE owner_kind = ? AND owner_id = ?",
      )
      .run(ownerKind, ownerId).changes;
  }

  listActiveAttachmentLeases(timestamp = now()): AttachmentLeaseRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_lease
       WHERE expires_at > ?
       ORDER BY asset_id, owner_kind, owner_id`,
      )
      .all(timestamp) as Array<Record<string, unknown>>;
    return rows.map(attachmentLeaseFromRow);
  }

  listAttachmentLeases(): AttachmentLeaseRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_lease
       ORDER BY asset_id, owner_kind, owner_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(attachmentLeaseFromRow);
  }

  deleteExpiredAttachmentLeases(timestamp = now()): number {
    return this.database
      .prepare("DELETE FROM attachment_lease WHERE expires_at <= ?")
      .run(timestamp).changes;
  }

  purgeDeletedAttachment(
    assetId: string,
    timestamp = now(),
  ): AttachmentAssetRecord | undefined {
    return this.database
      .transaction(() => {
        const asset = this.getAttachment(assetId, { includeDeleted: true });
        if (asset?.status !== "deleted") return undefined;
        const references = this.countAttachmentReferences(assetId);
        if (references > 0) return undefined;
        const activeLease = this.database
          .prepare(
            `SELECT 1 FROM attachment_lease
         WHERE asset_id = ? AND expires_at > ? LIMIT 1`,
          )
          .get(assetId, timestamp);
        if (activeLease) return undefined;
        const result = this.database
          .prepare(
            "DELETE FROM attachment_asset WHERE id = ? AND status = 'deleted'",
          )
          .run(assetId);
        return result.changes === 1 ? asset : undefined;
      })
      .immediate();
  }

  findCompletedAttachmentRepresentation(
    assetId: string,
    kind: AttachmentRepresentationKind,
    cacheKey: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_representation
       WHERE asset_id = ? AND kind = ? AND cache_key = ? AND status = 'completed'
       LIMIT 1`,
      )
      .get(assetId, kind, cacheKey) as Record<string, unknown> | undefined;
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  completeAttachmentRepresentation(
    id: string,
    input: {
      text: string;
      metadata: Record<string, unknown>;
      updatedAt?: number;
    },
  ): AttachmentRepresentationRecord {
    const updatedAt = input.updatedAt ?? now();
    const result = this.database
      .prepare(
        `UPDATE attachment_representation
       SET status = 'completed', text = ?, error = NULL, metadata_json = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      )
      .run(input.text, encode(input.metadata), updatedAt, id);
    if (result.changes !== 1)
      throw new Error(`Attachment representation ${id} is not running`);
    return this.getAttachmentRepresentation(id)!;
  }

  failAttachmentRepresentation(
    id: string,
    error: string,
    updatedAt = now(),
  ): AttachmentRepresentationRecord {
    const result = this.database
      .prepare(
        `UPDATE attachment_representation
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      )
      .run(error, updatedAt, id);
    if (result.changes !== 1)
      throw new Error(`Attachment representation ${id} is not running`);
    return this.getAttachmentRepresentation(id)!;
  }

  softDeleteAttachment(id: string, deletedAt = now()): AttachmentAssetRecord {
    const current = this.attachmentForTransition(id, "ready");
    parseAttachmentAssetRecord({
      ...current,
      status: "deleted",
      deletedAt,
      updatedAt: deletedAt,
    });
    const result = this.database
      .prepare(
        `UPDATE attachment_asset
         SET status = 'deleted', deleted_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ready'`,
      )
      .run(deletedAt, deletedAt, id);
    if (result.changes !== 1) {
      throw this.attachmentTransitionError(id, "ready");
    }
    return this.getAttachment(id, { includeDeleted: true })!;
  }

  softDeleteUnreferencedAttachment(
    id: string,
    deletedAt = now(),
  ): AttachmentAssetRecord {
    return this.database
      .transaction(() => {
        if (this.countAttachmentReferences(id) > 0) {
          throw new AttachmentError(
            "attachment_in_use",
            "attachment is referenced by a conversation",
          );
        }
        return this.softDeleteAttachment(id, deletedAt);
      })
      .immediate();
  }

  private attachmentTransitionError(id: string, expected: string): Error {
    const current = this.getAttachment(id, { includeDeleted: true });
    return current
      ? new Error(
          `Attachment ${id} expected ${expected} status, received ${current.status}`,
        )
      : new Error(
          `Attachment ${id} was not found; expected ${expected} status`,
        );
  }

  private attachmentForTransition(
    id: string,
    expected: AttachmentAssetRecord["status"],
  ): AttachmentAssetRecord {
    const current = this.getAttachment(id, { includeDeleted: true });
    if (!current || current.status !== expected) {
      throw this.attachmentTransitionError(id, expected);
    }
    return current;
  }

  listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const where = options.includeArchived ? "" : "WHERE p.archived_at IS NULL";
    return (
      this.database
        .prepare(
          `SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' ${where} ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.created_at DESC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map(projectFromRow);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE p.id = ?",
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  inspectProject(inputPath: string): ProjectRecord {
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const row = this.database
      .prepare(
        "SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE l.normalized_path = ?",
      )
      .get(normalizedPath) as Record<string, unknown> | undefined;
    const timestamp = now();
    if (row) {
      this.database
        .prepare(
          "UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, row.id);
      this.database
        .prepare(
          "UPDATE project_location SET last_verified_at = ? WHERE project_id = ? AND status = 'active'",
        )
        .run(timestamp, row.id);
      return this.getProject(row.id as string)!;
    }
    const projectId = randomUUID();
    this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO project (id, name, pinned_at, default_shell, last_opened_at, archived_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)",
        )
        .run(projectId, basename(path), timestamp, timestamp, timestamp);
      this.database
        .prepare(
          "INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          randomUUID(),
          projectId,
          path,
          normalizedPath,
          timestamp,
          timestamp,
        );
    })();
    return this.getProject(projectId)!;
  }

  renameProject(projectId: string, name: string): ProjectRecord {
    const value = name.replace(/\s+/g, " ").trim();
    if (!value) throw new Error("Project name is required");
    if (
      this.database
        .prepare("UPDATE project SET name = ?, updated_at = ? WHERE id = ?")
        .run(value, now(), projectId).changes === 0
    )
      throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  setProjectPinned(projectId: string, pinned: boolean): ProjectRecord {
    if (
      this.database
        .prepare(
          "UPDATE project SET pinned_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(pinned ? now() : null, now(), projectId).changes === 0
    )
      throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  setProjectDefaultShell(
    projectId: string,
    shell: string | null,
  ): ProjectRecord {
    const value = shell?.replace(/\s+/g, " ").trim() ?? "";
    if (
      this.database
        .prepare(
          "UPDATE project SET default_shell = ?, updated_at = ? WHERE id = ?",
        )
        .run(value || null, now(), projectId).changes === 0
    )
      throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  archiveProject(projectId: string): ProjectRecord {
    const timestamp = now();
    if (
      this.database
        .prepare(
          "UPDATE project SET archived_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, projectId).changes === 0
    )
      throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  rebindProject(projectId: string, inputPath: string): ProjectRecord {
    if (!this.getProject(projectId))
      throw new Error(`Project not found: ${projectId}`);
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const conflict = this.database
      .prepare(
        "SELECT project_id FROM project_location WHERE normalized_path = ? AND status = 'active'",
      )
      .get(normalizedPath) as { project_id?: string } | undefined;
    if (conflict?.project_id && conflict.project_id !== projectId)
      throw new Error("Project directory is already bound to another project");
    const timestamp = now();
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE project_location SET status = 'historical' WHERE project_id = ? AND status = 'active'",
        )
        .run(projectId);
      this.database
        .prepare(
          "INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          randomUUID(),
          projectId,
          path,
          normalizedPath,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          "UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, projectId);
      for (const session of Object.values(this.state.sessions)) {
        if (session.projectId !== projectId) continue;
        session.cwd = resolve(path, session.cwdRelative ?? "");
        this.database
          .prepare("UPDATE session SET cwd = ? WHERE id = ?")
          .run(session.cwd, session.id);
      }
    })();
    return this.getProject(projectId)!;
  }

  createScheduledTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO scheduled_task (
          id, name, description, prompt, recurrence, recurrence_format, timezone,
          status, destination, session_id, project_paths_json, execution_mode,
          model, effort, skill_names_json, plugin_names_json, permission_profile_json,
          overlap_policy, missed_run_policy, stop_policy_json, created_by,
          created_from_session_id, last_run_at, next_run_at, run_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
      `,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.prompt,
        input.recurrence,
        input.recurrenceFormat,
        input.timezone,
        input.status ?? "active",
        input.destination,
        input.sessionId ?? null,
        encode(input.projectPaths ?? []),
        input.executionMode ?? "local",
        input.model ?? null,
        input.effort ?? null,
        encode(input.skillNames ?? []),
        encode(input.pluginNames ?? []),
        encode(input.permissionProfile ?? { mode: "workspace_write" }),
        input.overlapPolicy ?? "skip",
        input.missedRunPolicy ?? "skip",
        input.stopPolicy ? encode(input.stopPolicy) : null,
        input.createdBy ?? "user",
        input.createdFromSessionId ?? null,
        input.nextRunAt ?? null,
        timestamp,
        timestamp,
      );
    return this.getScheduledTask(id)!;
  }

  getScheduledTask(id: string): ScheduledTaskRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduled_task WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? scheduledTaskFromRow(row) : undefined;
  }

  listScheduledTasks(
    options: { status?: ScheduledTaskRecord["status"] } = {},
  ): ScheduledTaskRecord[] {
    const rows = options.status
      ? this.database
          .prepare(
            "SELECT * FROM scheduled_task WHERE status = ? ORDER BY created_at DESC",
          )
          .all(options.status)
      : this.database
          .prepare("SELECT * FROM scheduled_task ORDER BY created_at DESC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(scheduledTaskFromRow);
  }

  updateScheduledTask(
    id: string,
    patch: UpdateScheduledTaskInput,
  ): ScheduledTaskRecord {
    const current = this.getScheduledTask(id);
    if (!current) throw new Error(`Scheduled task not found: ${id}`);
    const updated: ScheduledTaskRecord = {
      ...current,
      ...withoutUndefined(patch),
      updatedAt: now(),
    } as ScheduledTaskRecord;
    if (patch.lastRunAt === null) delete updated.lastRunAt;
    if (patch.nextRunAt === null) delete updated.nextRunAt;
    this.database
      .prepare(
        `
        UPDATE scheduled_task SET
          name = ?, description = ?, prompt = ?, recurrence = ?, recurrence_format = ?,
          timezone = ?, status = ?, destination = ?, session_id = ?, project_paths_json = ?,
          execution_mode = ?, model = ?, effort = ?, skill_names_json = ?, plugin_names_json = ?,
          permission_profile_json = ?, overlap_policy = ?, missed_run_policy = ?, stop_policy_json = ?,
          created_by = ?, created_from_session_id = ?, last_run_at = ?, next_run_at = ?,
          run_count = ?, updated_at = ? WHERE id = ?
      `,
      )
      .run(
        updated.name,
        updated.description ?? null,
        updated.prompt,
        updated.recurrence,
        updated.recurrenceFormat,
        updated.timezone,
        updated.status,
        updated.destination,
        updated.sessionId ?? null,
        encode(updated.projectPaths),
        updated.executionMode,
        updated.model ?? null,
        updated.effort ?? null,
        encode(updated.skillNames),
        encode(updated.pluginNames),
        encode(updated.permissionProfile),
        updated.overlapPolicy,
        updated.missedRunPolicy,
        updated.stopPolicy ? encode(updated.stopPolicy) : null,
        updated.createdBy,
        updated.createdFromSessionId ?? null,
        updated.lastRunAt ?? null,
        updated.nextRunAt ?? null,
        updated.runCount,
        updated.updatedAt,
        id,
      );
    return this.getScheduledTask(id)!;
  }

  deleteScheduledTask(id: string): boolean {
    return this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM scheduled_run WHERE task_id = ?")
        .run(id);
      return (
        this.database.prepare("DELETE FROM scheduled_task WHERE id = ?").run(id)
          .changes > 0
      );
    })();
  }

  createScheduledRun(input: CreateScheduledRunInput): ScheduledRunRecord {
    if (!this.getScheduledTask(input.taskId)) {
      throw new Error(`Scheduled task not found: ${input.taskId}`);
    }
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO scheduled_run (
          id, task_id, cause, status, scheduled_for, unread, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?)
      `,
      )
      .run(
        id,
        input.taskId,
        input.cause,
        input.scheduledFor,
        timestamp,
        timestamp,
      );
    return this.getScheduledRun(id)!;
  }

  getScheduledRun(id: string): ScheduledRunRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduled_run WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? scheduledRunFromRow(row) : undefined;
  }

  listScheduledRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    let sql = "SELECT * FROM scheduled_run";
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (options.taskId) {
      conditions.push("task_id = ?");
      values.push(options.taskId);
    }
    if (options.unread !== undefined) {
      conditions.push("unread = ?");
      values.push(options.unread ? 1 : 0);
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC LIMIT ?";
    values.push(limit);
    return (
      this.database.prepare(sql).all(...values) as Array<
        Record<string, unknown>
      >
    ).map(scheduledRunFromRow);
  }

  updateScheduledRun(
    id: string,
    patch: UpdateScheduledRunInput,
  ): ScheduledRunRecord {
    const current = this.getScheduledRun(id);
    if (!current) throw new Error(`Scheduled run not found: ${id}`);
    const updated = {
      ...current,
      ...withoutUndefined(patch),
      updatedAt: now(),
    } as ScheduledRunRecord;
    this.database
      .prepare(
        `
        UPDATE scheduled_run SET status = ?, session_id = ?, run_id = ?, summary = ?,
          error = ?, unread = ?, attention_reason = ?, started_at = ?, finished_at = ?,
          updated_at = ? WHERE id = ?
      `,
      )
      .run(
        updated.status,
        updated.sessionId ?? null,
        updated.runId ?? null,
        updated.summary ?? null,
        updated.error ?? null,
        updated.unread ? 1 : 0,
        updated.attentionReason ?? null,
        updated.startedAt ?? null,
        updated.finishedAt ?? null,
        updated.updatedAt,
        id,
      );
    return this.getScheduledRun(id)!;
  }

  interruptActiveScheduledRuns(reason: string): number {
    return this.database
      .prepare(
        `
        UPDATE scheduled_run SET status = 'interrupted', error = ?, unread = 1,
          finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running')
      `,
      )
      .run(reason, now(), now()).changes;
  }

  /**
   * Groups synchronous store mutations into one durable commit. Both SQLite
   * rows and the in-memory read model return to their previous state on error.
   */
  transaction<T>(work: () => T): T {
    const previous = structuredClone(this.state);
    const previousDirtyPartIds = new Set(this.dirtyDeltaPartIds);
    const previousPendingDeltaBytes = this.pendingDeltaBytes;
    const previousSaveRequested = this.saveRequested;
    const previousReservedEventSeq = this.reservedEventSeq;
    const previousMutations = cloneMutationBuffer(this.mutations);
    this.transactionDepth += 1;
    if (this.transactionDepth === 1) this.saveRequested = false;
    let persisted = false;
    let completed = false;
    try {
      const result = this.database.transaction(() => {
        const value = work();
        if (this.transactionDepth === 1 && this.saveRequested) {
          this.persistChanges();
          persisted = true;
        }
        return value;
      })();
      if (persisted) {
        this.clearDirtyDeltas();
        this.mutations = createMutationBuffer();
      }
      completed = true;
      return result;
    } catch (error) {
      this.state = previous;
      this.restoreDirtyDeltas(previousDirtyPartIds, previousPendingDeltaBytes);
      this.saveRequested = previousSaveRequested;
      this.reservedEventSeq = previousReservedEventSeq;
      this.mutations = previousMutations;
      throw error;
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.saveRequested = previousSaveRequested;
        if (this.dirtyDeltaPartIds.size > 0) {
          if (completed && this.pendingDeltaBytes >= this.deltaFlushBytes)
            this.flushMessagePartDeltas();
          else this.scheduleDeltaFlush();
        }
      }
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? randomUUID();
    if (this.state.sessions[id])
      throw new Error(`Session already exists: ${id}`);
    const timestamp = now();
    const projectId =
      input.projectId ??
      (input.parentId
        ? this.state.sessions[input.parentId]?.projectId
        : undefined);
    const project = projectId
      ? this.getProject(projectId)
      : this.inspectProject(input.cwd);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const cwd = resolve(input.cwd);
    const session: SessionRecord = {
      id,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      projectId: project.id,
      cwd,
      cwdRelative: relative(project.path, cwd),
      title: input.title ?? "",
      model: input.model,
      ...(input.agent ? { agent: input.agent } : {}),
      status: "idle",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.sessions[id] = session;
    this.mutations.sessions.add(id);
    this.appendEventInMemory({
      type: "session.created",
      sessionId: id,
      payload: { session },
    });
    this.save();
    return clone(session);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.state.sessions[sessionId];
    return session ? clone(session) : undefined;
  }

  listSessions(options: ListSessionsOptions = {}): SessionRecord[] {
    const cwd = options.cwd ? resolve(options.cwd) : undefined;
    let sessions = Object.values(this.state.sessions);
    if (cwd) sessions = sessions.filter((session) => session.cwd === cwd);
    if (!options.includeArchived)
      sessions = sessions.filter((session) => session.status !== "archived");
    sessions = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options.limit !== undefined)
      sessions = sessions.slice(0, options.limit);
    return clone(sessions);
  }

  listChildSessions(
    parentId: string,
    options: { includeArchived?: boolean } = {},
  ): SessionRecord[] {
    assertSession(this.state, parentId);
    return clone(
      Object.values(this.state.sessions)
        .filter(
          (session) =>
            session.parentId === parentId &&
            (options.includeArchived || session.status !== "archived"),
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  deleteSessionTree(sessionId: string): string[] {
    if (this.transactionDepth > 0) {
      throw new Error(
        "deleteSessionTree cannot be called inside a store transaction",
      );
    }
    assertSession(this.state, sessionId);
    const sessionIds = this.collectSessionTreeIds(sessionId);
    const sessionIdSet = new Set(sessionIds);
    const runIds = new Set(
      Object.values(this.state.runs)
        .filter((run) => sessionIdSet.has(run.sessionId))
        .map((run) => run.id),
    );

    this.database.transaction(() => {
      const placeholders = sessionIds.map(() => "?").join(", ");
      this.database
        .prepare(
          `DELETE FROM permission_request WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_task WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_run_attempt WHERE run_id IN (SELECT id FROM session_run WHERE session_id IN (${placeholders}))`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_run WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_message_part WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_message WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_input WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(
          `DELETE FROM session_event WHERE session_id IN (${placeholders})`,
        )
        .run(...sessionIds);
      this.database
        .prepare(`DELETE FROM session WHERE id IN (${placeholders})`)
        .run(...sessionIds);
    })();

    for (const id of sessionIds) delete this.state.sessions[id];
    for (const [id, input] of Object.entries(this.state.inputs)) {
      if (sessionIdSet.has(input.sessionId)) delete this.state.inputs[id];
    }
    for (const [id, reference] of Object.entries(this.state.inputAttachments)) {
      if (sessionIdSet.has(reference.sessionId)) {
        delete this.state.inputAttachments[id];
      }
    }
    for (const [id, message] of Object.entries(this.state.messages)) {
      if (sessionIdSet.has(message.sessionId)) delete this.state.messages[id];
    }
    for (const [id, part] of Object.entries(this.state.parts)) {
      if (sessionIdSet.has(part.sessionId)) {
        delete this.state.parts[id];
        this.dirtyDeltaPartIds.delete(id);
      }
    }
    if (this.dirtyDeltaPartIds.size === 0) this.pendingDeltaBytes = 0;
    for (const [id, run] of Object.entries(this.state.runs)) {
      if (sessionIdSet.has(run.sessionId)) delete this.state.runs[id];
    }
    for (const [id, attempt] of Object.entries(this.state.attempts)) {
      if (runIds.has(attempt.runId)) delete this.state.attempts[id];
    }
    for (const [id, task] of Object.entries(this.state.tasks)) {
      if (sessionIdSet.has(task.sessionId)) delete this.state.tasks[id];
    }
    for (const [id, permission] of Object.entries(this.state.permissions)) {
      if (sessionIdSet.has(permission.sessionId))
        delete this.state.permissions[id];
    }
    this.state.events = this.state.events.filter(
      (event) => !event.sessionId || !sessionIdSet.has(event.sessionId),
    );
    this.mutations = createMutationBuffer();

    return sessionIds;
  }

  archiveSession(sessionId: string): SessionRecord {
    const session = assertSession(this.state, sessionId);
    if (session.status === "archived") return clone(session);
    const timestamp = now();
    session.status = "archived";
    session.updatedAt = timestamp;
    session.archivedAt = timestamp;
    this.mutations.sessions.add(sessionId);
    this.appendEventInMemory({
      type: "session.archived",
      sessionId,
      payload: { sessionId },
    });
    this.save();
    return clone(session);
  }

  /** Prevent further mutation while the server joins interrupted work. */
  beginArchive(sessionId: string): SessionRecord {
    const session = assertSession(this.state, sessionId);
    if (session.status === "archived" || session.status === "closing")
      return clone(session);
    const timestamp = now();
    session.status = "closing";
    session.updatedAt = timestamp;
    this.mutations.sessions.add(sessionId);
    this.appendEventInMemory({
      type: "session.closing",
      sessionId,
      payload: { sessionId },
    });
    this.save();
    return clone(session);
  }

  updateSession(sessionId: string, input: UpdateSessionInput): SessionRecord {
    const session = assertSession(this.state, sessionId);
    assertMutableSession(session);
    const timestamp = now();
    if (input.title !== undefined) session.title = input.title;
    if (input.model !== undefined) session.model = input.model;
    if (input.agent !== undefined) {
      if (input.agent === null) delete session.agent;
      else session.agent = input.agent;
    }
    if (input.metadata !== undefined) session.metadata = input.metadata;
    session.updatedAt = timestamp;
    this.mutations.sessions.add(sessionId);
    this.appendEventInMemory({
      type: "session.updated",
      sessionId,
      payload: { session: clone(session) },
    });
    this.save();
    return clone(session);
  }

  admitPrompt(
    input: StoreAdmitPromptInput,
    options: { attachmentLimits?: Partial<AttachmentLimits> } = {},
  ): SessionInputRecord {
    return this.transaction(() => {
      const attachmentLimits = options.attachmentLimits
        ? parseAttachmentLimits({
            ...this.attachmentLimits,
            ...options.attachmentLimits,
          })
        : this.attachmentLimits;
      const session = assertSession(this.state, input.sessionId);
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
      const existing = this.state.inputs[id];
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
        Object.values(this.state.inputAttachments).filter(
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
      const seq = maxSeq(this.state.inputs, input.sessionId) + 1;
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
      this.state.inputs[id] = row;
      for (const reference of attachments) {
        this.state.inputAttachments[reference.id] = reference;
        this.mutations.inputAttachments.add(reference.id);
      }
      session.updatedAt = timestamp;
      if (seq === 1 && isPlaceholderSessionTitle(session.title)) {
        const title = formatSessionTitle(content);
        if (title) session.title = title;
      }
      this.mutations.inputs.add(id);
      this.mutations.sessions.add(input.sessionId);
      this.appendEventInMemory({
        type: "session.input.admitted",
        sessionId: input.sessionId,
        payload: { input: row },
      });
      this.save();
      return clone(row);
    });
  }

  async backupDatabase(destination: string): Promise<void> {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    mkdirSync(dirname(resolve(destination)), { recursive: true });
    const path = resolve(destination);
    await this.database.backup(path);
    const backup = new Database(path);
    try {
      // owner 是当前进程的活租约，不能带进恢复目录；Run/Workflow 保留给启动恢复收束。
      backup.prepare("DELETE FROM application_owner").run();
    } finally {
      backup.close();
    }
  }

  saveWorkflowRun(input: StoredWorkflowRunInput): void {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    this.database.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO workflow_run
          (run_id, owner_session_id, owner_input_id, owner_run_id, status, termination,
           snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          owner_session_id = excluded.owner_session_id,
          owner_input_id = excluded.owner_input_id,
          owner_run_id = excluded.owner_run_id,
          status = excluded.status,
          termination = excluded.termination,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          input.runId,
          input.ownerSessionId ?? null,
          input.ownerInputId ?? null,
          input.ownerRunId ?? null,
          input.status,
          input.termination ?? null,
          input.snapshotJson,
          input.createdAt,
          input.updatedAt,
        );
      this.database
        .prepare("DELETE FROM workflow_task_attempt WHERE workflow_run_id = ?")
        .run(input.runId);
      const insertAttempt = this.database.prepare(`
        INSERT INTO workflow_task_attempt
          (workflow_run_id, task_id, attempt, status, payload_json, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const attempt of input.taskAttempts) {
        insertAttempt.run(
          input.runId,
          attempt.taskId,
          attempt.attempt,
          attempt.status,
          attempt.payloadJson,
          attempt.startedAt,
          attempt.finishedAt ?? null,
        );
      }
    })();
  }

  loadWorkflowRun(runId: string): StoredWorkflowRunRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM workflow_run WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? storedWorkflowRunFromRow(row) : undefined;
  }

  listWorkflowRuns(
    options: { ownerSessionId?: string; status?: string } = {},
  ): StoredWorkflowRunRecord[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.ownerSessionId) {
      clauses.push("owner_session_id = ?");
      parameters.push(options.ownerSessionId);
    }
    if (options.status) {
      clauses.push("status = ?");
      parameters.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.database
        .prepare(`SELECT * FROM workflow_run ${where} ORDER BY updated_at DESC`)
        .all(...parameters) as Array<Record<string, unknown>>
    ).map(storedWorkflowRunFromRow);
  }

  appendWorkflowEvent(input: {
    runId: string;
    sessionId?: string;
    type: string;
    eventJson: string;
    createdAt: number;
  }): number {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    const result = this.database
      .prepare(
        `
      INSERT INTO workflow_event (workflow_run_id, type, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(input.runId, input.type, input.eventJson, input.createdAt);
    if (input.sessionId) {
      this.appendEvent({
        type: `workflow.${input.type}`,
        sessionId: input.sessionId,
        payload: {
          event: JSON.parse(input.eventJson) as Record<string, unknown>,
        },
      });
    }
    return Number(result.lastInsertRowid);
  }

  listWorkflowEvents(runId: string): string[] {
    return (
      this.database
        .prepare(
          "SELECT event_json FROM workflow_event WHERE workflow_run_id = ? ORDER BY seq",
        )
        .all(runId) as Array<{ event_json: string }>
    ).map((row) => row.event_json);
  }

  acquireApplicationOwner(input: {
    ownerId: string;
    pid: number;
    staleAfterMs: number;
    now?: number;
    /** 仅在调用方已经独立确认当前 owner 不可能继续写入时返回 true。 */
    canTakeOver?: (current: ApplicationOwnerLease) => boolean;
  }): ApplicationOwnerLease {
    const timestamp = input.now ?? Date.now();
    const lease = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM application_owner WHERE key = 'application'")
        .get() as Record<string, unknown> | undefined;
      const current = row ? applicationOwnerFromRow(row) : undefined;
      if (
        current &&
        current.heartbeatAt > timestamp - input.staleAfterMs &&
        !input.canTakeOver?.(current)
      ) {
        throw new ApplicationOwnerConflictError(current);
      }
      const generation = (current?.generation ?? 0) + 1;
      const next: ApplicationOwnerLease = {
        ownerId: input.ownerId,
        pid: input.pid,
        generation,
        startedAt: timestamp,
        heartbeatAt: timestamp,
      };
      this.database
        .prepare(
          `
        INSERT INTO application_owner (key, owner_id, pid, generation, started_at, heartbeat_at)
        VALUES ('application', ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          owner_id = excluded.owner_id,
          pid = excluded.pid,
          generation = excluded.generation,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at
      `,
        )
        .run(
          next.ownerId,
          next.pid,
          next.generation,
          next.startedAt,
          next.heartbeatAt,
        );
      return next;
    })();
    this.activeOwnerLease = lease;
    return lease;
  }

  heartbeatApplicationOwner(
    lease: ApplicationOwnerLease,
    timestamp = Date.now(),
  ): ApplicationOwnerLease {
    const result = this.database
      .prepare(
        `
      UPDATE application_owner SET heartbeat_at = ?
      WHERE key = 'application' AND owner_id = ? AND generation = ?
    `,
      )
      .run(timestamp, lease.ownerId, lease.generation);
    if (result.changes !== 1) this.throwOwnerFenceError();
    const next = { ...lease, heartbeatAt: timestamp };
    this.activeOwnerLease = next;
    return next;
  }

  releaseApplicationOwner(lease: ApplicationOwnerLease): void {
    this.database
      .prepare(
        `
      DELETE FROM application_owner
      WHERE key = 'application' AND owner_id = ? AND generation = ?
    `,
      )
      .run(lease.ownerId, lease.generation);
    if (
      this.activeOwnerLease?.ownerId === lease.ownerId &&
      this.activeOwnerLease.generation === lease.generation
    )
      this.activeOwnerLease = undefined;
  }

  assertApplicationOwner(lease: ApplicationOwnerLease): void {
    const row = this.database
      .prepare("SELECT * FROM application_owner WHERE key = 'application'")
      .get() as Record<string, unknown> | undefined;
    if (!row) this.throwOwnerFenceError();
    const current = applicationOwnerFromRow(row!);
    if (
      current.ownerId !== lease.ownerId ||
      current.generation !== lease.generation
    ) {
      throw new ApplicationOwnerConflictError(current);
    }
  }

  applyRetention(
    policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
    timestamp = Date.now(),
  ): {
    events: number;
    workflowEvents: number;
    workflows: number;
    runAttempts: number;
    settlements: number;
  } {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    const result = this.database.transaction(() => {
      const workflowEvents = this.database
        .prepare(
          `
        DELETE FROM workflow_event
        WHERE created_at < ? AND workflow_run_id IN (
          SELECT run_id FROM workflow_run WHERE status != 'running'
        )
      `,
        )
        .run(timestamp - policy.workflowEventMaxAgeMs).changes;
      const workflows = this.database
        .prepare(
          `
        DELETE FROM workflow_run
        WHERE updated_at < ? AND status != 'running'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_execution_claim c
            WHERE c.workflow_run_id = workflow_run.run_id AND c.status = 'running'
          )
      `,
        )
        .run(timestamp - policy.workflowRunMaxAgeMs).changes;
      const runAttempts = this.database
        .prepare(
          `
        DELETE FROM session_run_attempt
        WHERE updated_at < ? AND status NOT IN ('pending', 'running')
      `,
        )
        .run(timestamp - policy.runAttemptMaxAgeMs).changes;
      const settlements = this.database
        .prepare(
          `
        DELETE FROM projection_settlement
        WHERE updated_at < ? AND status IN ('resolved', 'abandoned')
      `,
        )
        .run(timestamp - policy.projectionSettlementMaxAgeMs).changes;
      const removableEvents = this.database
        .prepare(
          `
        SELECT e.id FROM session_event e
        LEFT JOIN session s ON s.id = e.session_id
        WHERE e.created_at < ?
          AND e.session_id IS NOT NULL
          AND s.status = 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM session_run r
            WHERE r.session_id = e.session_id AND r.status IN ('pending', 'running')
          )
      `,
        )
        .all(timestamp - policy.durableEventMaxAgeMs) as Array<{ id: string }>;
      if (removableEvents.length > 0) {
        const remove = this.database.prepare(
          "DELETE FROM session_event WHERE id = ?",
        );
        for (const event of removableEvents) remove.run(event.id);
      }
      const retentionResult = {
        events: removableEvents.length,
        workflowEvents,
        workflows,
        runAttempts,
        settlements,
      };
      this.database
        .prepare(
          `
        INSERT INTO retention_audit (id, policy, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          randomUUID(),
          JSON.stringify(policy),
          JSON.stringify(retentionResult),
          timestamp,
        );
      return retentionResult;
    })();
    if (result.events > 0) {
      const removed = new Set(
        (
          this.database.prepare("SELECT id FROM session_event").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      );
      this.state.events = this.state.events.filter((event) =>
        removed.has(event.id),
      );
    }
    return result;
  }

  listRetentionAudits(): Array<Record<string, unknown>> {
    return this.database
      .prepare("SELECT * FROM retention_audit ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
  }

  recordRetentionAudit(input: {
    policy: string;
    result: unknown;
    timestamp?: number;
  }): void {
    this.database
      .prepare(
        `INSERT INTO retention_audit (id, policy, result_json, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.policy,
        JSON.stringify(input.result),
        input.timestamp ?? now(),
      );
  }

  latestRetentionAudit(policy: string):
    | {
        id: string;
        policy: string;
        result: unknown;
        createdAt: number;
      }
    | undefined {
    const row = this.database
      .prepare(
        `SELECT id, policy, result_json, created_at
       FROM retention_audit
       WHERE policy = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      )
      .get(policy) as
      | {
          id: string;
          policy: string;
          result_json: string;
          created_at: number;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          policy: row.policy,
          result: JSON.parse(row.result_json) as unknown,
          createdAt: row.created_at,
        }
      : undefined;
  }

  claimWorkflowRun(
    runId: string,
    ownerId: string,
  ): { ownerId: string; generation: number; claimedAt: number } {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    return this.database.transaction(() => {
      const current = this.database
        .prepare(
          `
        SELECT owner_id, generation, status FROM workflow_execution_claim
        WHERE workflow_run_id = ?
      `,
        )
        .get(runId) as
        { owner_id: string; generation: number; status: string } | undefined;
      if (current?.status === "running" && current.owner_id === ownerId) {
        throw new Error(
          `Workflow run is already claimed by this Application: ${runId}`,
        );
      }
      const generation = (current?.generation ?? 0) + 1;
      const claimedAt = Date.now();
      this.database
        .prepare(
          `
        INSERT INTO workflow_execution_claim
          (workflow_run_id, owner_id, generation, claimed_at, heartbeat_at, finished_at, status)
        VALUES (?, ?, ?, ?, ?, NULL, 'running')
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          claimed_at = excluded.claimed_at,
          heartbeat_at = excluded.heartbeat_at,
          finished_at = NULL,
          status = 'running'
      `,
        )
        .run(runId, ownerId, generation, claimedAt, claimedAt);
      return { ownerId, generation, claimedAt };
    })();
  }

  finishWorkflowRunClaim(runId: string, ownerId: string, status: string): void {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    const result = this.database
      .prepare(
        `
      UPDATE workflow_execution_claim
      SET status = ?, finished_at = ?, heartbeat_at = ?
      WHERE workflow_run_id = ? AND owner_id = ? AND status = 'running'
    `,
      )
      .run(status, Date.now(), Date.now(), runId, ownerId);
    if (result.changes !== 1) {
      throw new Error(
        `Workflow run claim is not active for this Application: ${runId}`,
      );
    }
  }

  findExternalConversation(input: {
    connector: string;
    accountId: string;
    chatId: string;
    threadId?: string;
  }): ExternalConversationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM external_conversation
         WHERE connector = ? AND account_id = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(
        input.connector,
        input.accountId,
        input.chatId,
        input.threadId ?? "",
      ) as Record<string, unknown> | undefined;
    return row ? externalConversationFromRow(row) : undefined;
  }

  upsertExternalConversation(input: {
    id?: string;
    connector: string;
    accountId: string;
    workspaceId?: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
  }): ExternalConversationRecord {
    this.assertCurrentOwner();
    assertSession(this.state, input.sessionId);
    const existing = this.findExternalConversation(input);
    const timestamp = now();
    const id = existing?.id ?? input.id ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO external_conversation
          (id, connector, account_id, workspace_id, chat_id, thread_id, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connector, account_id, chat_id, thread_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.connector,
        input.accountId,
        input.workspaceId ?? null,
        input.chatId,
        input.threadId ?? "",
        input.sessionId,
        existing?.createdAt ?? timestamp,
        timestamp,
      );
    return this.findExternalConversation(input)!;
  }

  listExternalConversations(
    options: {
      connector?: string;
      limit?: number;
    } = {},
  ): ExternalConversationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM external_conversation
         ${options.connector ? "WHERE connector = ?" : ""}
         ORDER BY updated_at DESC
         ${options.limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(
        ...(options.connector ? [options.connector] : []),
        ...(options.limit !== undefined ? [options.limit] : []),
      ) as Array<Record<string, unknown>>;
    return rows.map(externalConversationFromRow);
  }

  createChannelDelivery(input: {
    id?: string;
    conversationId: string;
    connector: string;
    accountId: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
    inputId: string;
    runId: string;
    externalMessageId: string;
    content: string;
  }): ChannelDeliveryRecord {
    this.assertCurrentOwner();
    const existing = this.findChannelDeliveryByInput(input.inputId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.runId !== input.runId ||
        existing.content !== input.content
      ) {
        throw new Error(
          `Channel delivery input is already used: ${input.inputId}`,
        );
      }
      return existing;
    }
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO channel_delivery
          (id, conversation_id, connector, account_id, chat_id, thread_id,
           session_id, input_id, run_id, external_message_id, content, status,
           attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.connector,
        input.accountId,
        input.chatId,
        input.threadId ?? "",
        input.sessionId,
        input.inputId,
        input.runId,
        input.externalMessageId,
        input.content,
        timestamp,
        timestamp,
      );
    return this.getChannelDelivery(id)!;
  }

  getChannelDelivery(id: string): ChannelDeliveryRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM channel_delivery WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  findChannelDeliveryByInput(
    inputId: string,
  ): ChannelDeliveryRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM channel_delivery WHERE input_id = ?")
      .get(inputId) as Record<string, unknown> | undefined;
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  updateChannelDelivery(
    id: string,
    input: {
      status: Extract<ChannelDeliveryStatus, "sent" | "failed" | "unknown">;
      externalDeliveryId?: string;
      error?: string;
    },
  ): ChannelDeliveryRecord {
    this.assertCurrentOwner();
    const existing = this.getChannelDelivery(id);
    if (!existing) throw new Error(`Channel delivery not found: ${id}`);
    const timestamp = now();
    this.database
      .prepare(
        `UPDATE channel_delivery SET status = ?, attempt_count = attempt_count + ?,
          external_delivery_id = ?, error = ?, updated_at = ?, sent_at = ? WHERE id = ?`,
      )
      .run(
        input.status,
        input.status === "unknown" ? 1 : 0,
        input.externalDeliveryId ?? existing.externalDeliveryId ?? null,
        input.error ?? null,
        timestamp,
        input.status === "sent" ? timestamp : (existing.sentAt ?? null),
        id,
      );
    return this.getChannelDelivery(id)!;
  }

  listChannelDeliveries(
    options: {
      statuses?: ChannelDeliveryStatus[];
      connector?: string;
      limit?: number;
    } = {},
  ): ChannelDeliveryRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    if (options.connector) {
      clauses.push("connector = ?");
      values.push(options.connector);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM channel_delivery
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY updated_at DESC
         ${options.limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(
        ...values,
        ...(options.limit !== undefined ? [options.limit] : []),
      ) as Array<Record<string, unknown>>;
    return rows.map(channelDeliveryFromRow);
  }

  /** Atomically persists a queued prompt and the one root run that owns it. */
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
    return this.transaction(() => {
      const admitted = this.admitPrompt(
        {
          ...input.prompt,
          delivery: "queue",
        },
        options,
      );
      const existingRun = this.findOwningRunByInput(admitted.id);
      if (existingRun) return { input: admitted, run: existingRun };
      const run = this.createRun({
        id: input.run?.id,
        sessionId: admitted.sessionId,
        inputId: admitted.id,
        metadata: input.run?.metadata,
      });
      return { input: admitted, run };
    });
  }

  /**
   * Atomically replaces the visible transcript and admits the replacement
   * prompt. A daemon crash can therefore never persist only the destructive
   * half of an edit.
   */
  replaceTranscriptAndAdmitPrompt(input: {
    transcript: ReplaceTranscriptInput;
    admission: AdmitPromptWithRunInput;
    createRun: boolean;
  }): {
    transcript: {
      messages: SessionMessageRecord[];
      parts: SessionMessagePartRecord[];
    };
    input: SessionInputRecord;
    run?: SessionRunRecord;
  } {
    return this.transaction(() => {
      const transcript = this.replaceTranscript(input.transcript);
      if (input.createRun) {
        const admitted = this.admitPromptWithRun(input.admission);
        return { transcript, input: admitted.input, run: admitted.run };
      }
      const admitted = this.admitPrompt(input.admission.prompt);
      return { transcript, input: admitted };
    });
  }

  createReplayRun(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown> } = {},
  ): SessionRunRecord {
    const sourceInput = this.state.inputs[inputId];
    if (!sourceInput) throw new Error(`Session input not found: ${inputId}`);
    if (input.id) {
      const existing = this.state.runs[input.id];
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
    return this.createRun({
      id: input.id,
      sessionId: sourceInput.sessionId,
      inputId: sourceInput.id,
      metadata: input.metadata,
    });
  }

  replaceLatestPromptWithAdmission(input: {
    sessionId: string;
    sourceMessageId: string;
    admission: AdmitPromptWithRunInput;
    createRun: boolean;
  }): {
    transcript: {
      messages: SessionMessageRecord[];
      parts: SessionMessagePartRecord[];
    };
    input: SessionInputRecord;
    run?: SessionRunRecord;
  } {
    return this.transaction(() => {
      const session = assertSession(this.state, input.sessionId);
      const sourceMessage = assertMessage(this.state, input.sourceMessageId);
      if (
        sourceMessage.sessionId !== input.sessionId ||
        sourceMessage.role !== "user"
      ) {
        throw new Error(
          "The edit source must be a user message in the session",
        );
      }
      const sourceInput = sourceMessage.inputId
        ? this.state.inputs[sourceMessage.inputId]
        : undefined;
      if (!sourceInput || sourceInput.sessionId !== input.sessionId) {
        throw new Error("The edit source input is unavailable");
      }

      const removedMessages = Object.values(this.state.messages).filter(
        (message) =>
          message.sessionId === input.sessionId &&
          message.seq >= sourceMessage.seq,
      );
      const removedMessageIds = new Set(
        removedMessages.map((message) => message.id),
      );
      const removedInputs = Object.values(this.state.inputs).filter(
        (candidate) =>
          candidate.sessionId === input.sessionId &&
          candidate.seq >= sourceInput.seq,
      );
      const removedInputIds = new Set(
        removedInputs.map((candidate) => candidate.id),
      );
      const removedRuns = Object.values(this.state.runs).filter(
        (run) =>
          run.sessionId === input.sessionId &&
          (removedInputIds.has(run.inputId ?? "") ||
            removedMessages.some((message) => message.runId === run.id)),
      );
      const removedRunIds = new Set(removedRuns.map((run) => run.id));

      for (const [id, part] of Object.entries(this.state.parts)) {
        if (!removedMessageIds.has(part.messageId)) continue;
        delete this.state.parts[id];
        this.mutations.parts.delete(id);
        this.mutations.deletedParts.add(id);
        this.dirtyDeltaPartIds.delete(id);
      }
      for (const message of removedMessages) {
        delete this.state.messages[message.id];
        this.mutations.messages.delete(message.id);
        this.mutations.deletedMessages.add(message.id);
      }
      for (const [id, reference] of Object.entries(
        this.state.inputAttachments,
      )) {
        if (!removedInputIds.has(reference.inputId)) continue;
        delete this.state.inputAttachments[id];
        this.mutations.inputAttachments.delete(id);
        this.mutations.deletedInputAttachments.add(id);
      }
      for (const [id, attempt] of Object.entries(this.state.attempts)) {
        if (!removedRunIds.has(attempt.runId)) continue;
        delete this.state.attempts[id];
        this.mutations.attempts.delete(id);
        this.mutations.deletedAttempts.add(id);
      }
      for (const run of removedRuns) {
        delete this.state.runs[run.id];
        this.mutations.runs.delete(run.id);
        this.mutations.deletedRuns.add(run.id);
      }
      for (const candidate of removedInputs) {
        delete this.state.inputs[candidate.id];
        this.mutations.inputs.delete(candidate.id);
        this.mutations.deletedInputs.add(candidate.id);
      }
      this.refreshSessionStatus(session);

      const transcript = {
        messages: this.listMessages(input.sessionId),
        parts: this.listMessageParts(input.sessionId),
      };
      this.appendEventInMemory({
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

  forkSessionWithHistory(input: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    session: CreateSessionInput;
  }): SessionRecord {
    return this.transaction(() => {
      const source = assertSession(this.state, input.sourceSessionId);
      const sourceMessages = this.listMessages(source.id);
      const beforeMessage = input.beforeMessageId
        ? sourceMessages.find((message) => message.id === input.beforeMessageId)
        : undefined;
      const afterMessage = input.afterMessageId
        ? sourceMessages.find((message) => message.id === input.afterMessageId)
        : undefined;
      if (input.beforeMessageId && !beforeMessage) {
        throw new Error("Fork point not found");
      }
      if (input.afterMessageId && !afterMessage) {
        throw new Error("Fork point not found");
      }
      const beforeSeq = beforeMessage?.seq ?? Number.POSITIVE_INFINITY;
      const afterSeq = afterMessage?.seq ?? Number.POSITIVE_INFINITY;
      const copiedMessages = sourceMessages.filter(
        (message) => message.seq < beforeSeq && message.seq <= afterSeq,
      );
      const sourceParts = this.listMessageParts(source.id);
      const fork = this.createSession({
        ...input.session,
        parentId: source.id,
      });
      const inputIdMap = new Map<string, string>();
      const attachmentReferenceIdMap = new Map<string, string>();

      for (const message of copiedMessages) {
        if (!message.inputId || inputIdMap.has(message.inputId)) continue;
        const sourceInput = this.state.inputs[message.inputId];
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
          if (copiedReference) {
            attachmentReferenceIdMap.set(attachment.id, copiedReference.id);
          }
        });
      }

      for (const message of copiedMessages) {
        const copiedMessage = this.createMessage({
          sessionId: fork.id,
          role: message.role,
          ...(message.inputId && inputIdMap.has(message.inputId)
            ? { inputId: inputIdMap.get(message.inputId)! }
            : {}),
          metadata: message.metadata,
        });
        for (const part of sourceParts.filter(
          (candidate) => candidate.messageId === message.id,
        )) {
          const sourceReferenceId =
            typeof part.metadata.inputAttachmentId === "string"
              ? part.metadata.inputAttachmentId
              : undefined;
          this.upsertMessagePart({
            sessionId: fork.id,
            messageId: copiedMessage.id,
            type: part.type,
            status: part.status,
            ...(part.text !== undefined ? { text: part.text } : {}),
            ...(part.toolUseId !== undefined
              ? { toolUseId: part.toolUseId }
              : {}),
            ...(part.toolName !== undefined ? { toolName: part.toolName } : {}),
            ...(part.input !== undefined ? { input: part.input } : {}),
            ...(part.output !== undefined ? { output: part.output } : {}),
            ...(part.isError !== undefined ? { isError: part.isError } : {}),
            ...(part.assetId !== undefined ? { assetId: part.assetId } : {}),
            ...(part.intent !== undefined ? { intent: part.intent } : {}),
            ...(part.displayName !== undefined
              ? { displayName: part.displayName }
              : {}),
            ...(part.mediaType !== undefined
              ? { mediaType: part.mediaType }
              : {}),
            ...(part.sizeBytes !== undefined
              ? { sizeBytes: part.sizeBytes }
              : {}),
            ...(part.kind !== undefined ? { kind: part.kind } : {}),
            ...(part.representationId !== undefined
              ? { representationId: part.representationId }
              : {}),
            ...(part.processor !== undefined
              ? { processor: part.processor }
              : {}),
            ...(part.transformationError !== undefined
              ? { transformationError: part.transformationError }
              : {}),
            metadata:
              sourceReferenceId &&
              attachmentReferenceIdMap.has(sourceReferenceId)
                ? {
                    ...part.metadata,
                    inputAttachmentId:
                      attachmentReferenceIdMap.get(sourceReferenceId),
                  }
                : part.metadata,
          });
        }
      }
      return clone(assertSession(this.state, fork.id));
    });
  }

  /** Respect renamed titles; use the first prompt only for initial placeholder titles. */
  resolveSessionListTitle(sessionId: string): string {
    const session = assertSession(this.state, sessionId);
    const stored = session.title.trim();
    if (stored && !isPlaceholderSessionTitle(stored))
      return formatSessionTitle(stored);
    const first = Object.values(this.state.inputs)
      .filter((input) => input.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)[0];
    const fromPrompt = first ? formatSessionTitle(first.content) : "";
    if (fromPrompt) return fromPrompt;
    if (stored) return stored;
    return session.id.slice(0, 8);
  }

  getInput(inputId: string): SessionInputRecord | undefined {
    const input = this.state.inputs[inputId];
    return input ? clone(input) : undefined;
  }

  listInputAttachments(inputId: string): SessionInputAttachmentRecord[] {
    return clone(
      Object.values(this.state.inputAttachments)
        .filter((reference) => reference.inputId === inputId)
        .sort((left, right) => left.seq - right.seq),
    );
  }

  listSessionInputAttachments(
    sessionId: string,
  ): SessionInputAttachmentRecord[] {
    assertSession(this.state, sessionId);
    return clone(
      Object.values(this.state.inputAttachments)
        .filter((reference) => reference.sessionId === sessionId)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.seq - right.seq,
        ),
    );
  }

  countInputAttachmentReferences(assetId: string): number {
    return Object.values(this.state.inputAttachments).filter(
      (reference) => reference.assetId === assetId,
    ).length;
  }

  countAttachmentReferences(assetId: string): number {
    const inputReferences = this.countInputAttachmentReferences(assetId);
    const messageReferences = Object.values(this.state.parts).filter(
      (part) => part.type === "attachment" && part.assetId === assetId,
    ).length;
    return inputReferences + messageReferences;
  }

  listInputs(sessionId: string): SessionInputRecord[] {
    assertSession(this.state, sessionId);
    return clone(
      Object.values(this.state.inputs)
        .filter((input) => input.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  createMessage(input: CreateMessageInput): SessionMessageRecord {
    const session = assertSession(this.state, input.sessionId);
    const id = input.id ?? randomUUID();
    if (this.state.messages[id])
      throw new Error(`Session message already exists: ${id}`);
    const timestamp = now();
    const row: SessionMessageRecord = {
      id,
      sessionId: input.sessionId,
      seq: maxSeq(this.state.messages, input.sessionId) + 1,
      role: input.role,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inputId ? { inputId: input.inputId } : {}),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.messages[id] = row;
    session.updatedAt = timestamp;
    this.mutations.messages.add(id);
    this.mutations.sessions.add(input.sessionId);
    this.appendEventInMemory({
      type: "session.message.created",
      sessionId: input.sessionId,
      payload: { message: row },
    });
    this.save();
    return clone(row);
  }

  listMessages(
    sessionId: string,
    options: ListMessagesOptions = {},
  ): SessionMessageRecord[] {
    assertSession(this.state, sessionId);
    let messages = Object.values(this.state.messages)
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.afterSeq !== undefined)
      messages = messages.filter((message) => message.seq > options.afterSeq!);
    if (options.limit !== undefined)
      messages = messages.slice(0, options.limit);
    return clone(messages);
  }

  /**
   * Replace a session transcript atomically (used by /compact).
   * Emits a single `session.transcript.replaced` event with the new messages/parts.
   */
  replaceTranscript(input: ReplaceTranscriptInput): {
    messages: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  } {
    const session = assertSession(this.state, input.sessionId);
    const timestamp = now();

    for (const [id, message] of Object.entries(this.state.messages)) {
      if (message.sessionId === input.sessionId) {
        delete this.state.messages[id];
        this.mutations.messages.delete(id);
        this.mutations.deletedMessages.add(id);
      }
    }
    for (const [id, part] of Object.entries(this.state.parts)) {
      if (part.sessionId === input.sessionId) {
        delete this.state.parts[id];
        this.mutations.parts.delete(id);
        this.mutations.deletedParts.add(id);
        this.dirtyDeltaPartIds.delete(id);
      }
    }

    const messages: SessionMessageRecord[] = [];
    const parts: SessionMessagePartRecord[] = [];
    let messageSeq = 0;
    let partSeq = 0;

    for (const row of input.messages) {
      messageSeq += 1;
      const messageId = randomUUID();
      const message: SessionMessageRecord = {
        id: messageId,
        sessionId: input.sessionId,
        seq: messageSeq,
        role: row.role,
        metadata: row.metadata ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.messages[messageId] = message;
      this.mutations.messages.add(messageId);
      messages.push(message);

      for (const partInput of row.parts) {
        partSeq += 1;
        const partId = randomUUID();
        const part: SessionMessagePartRecord = {
          id: partId,
          sessionId: input.sessionId,
          messageId,
          seq: partSeq,
          type: partInput.type,
          status: partInput.status ?? "completed",
          ...(partInput.text !== undefined ? { text: partInput.text } : {}),
          ...(partInput.toolUseId !== undefined
            ? { toolUseId: partInput.toolUseId }
            : {}),
          ...(partInput.toolName !== undefined
            ? { toolName: partInput.toolName }
            : {}),
          ...(partInput.input !== undefined ? { input: partInput.input } : {}),
          ...(partInput.output !== undefined
            ? { output: partInput.output }
            : {}),
          ...(partInput.isError !== undefined
            ? { isError: partInput.isError }
            : {}),
          ...(partInput.assetId !== undefined
            ? { assetId: partInput.assetId }
            : {}),
          ...(partInput.intent !== undefined
            ? { intent: partInput.intent }
            : {}),
          ...(partInput.displayName !== undefined
            ? { displayName: partInput.displayName }
            : {}),
          ...(partInput.mediaType !== undefined
            ? { mediaType: partInput.mediaType }
            : {}),
          ...(partInput.sizeBytes !== undefined
            ? { sizeBytes: partInput.sizeBytes }
            : {}),
          ...(partInput.kind !== undefined ? { kind: partInput.kind } : {}),
          ...(partInput.representationId !== undefined
            ? { representationId: partInput.representationId }
            : {}),
          ...(partInput.processor !== undefined
            ? { processor: partInput.processor }
            : {}),
          ...(partInput.transformationError !== undefined
            ? { transformationError: partInput.transformationError }
            : {}),
          metadata: partInput.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.state.parts[partId] = part;
        this.mutations.parts.add(partId);
        parts.push(part);
      }
    }

    session.updatedAt = timestamp;
    this.mutations.sessions.add(input.sessionId);
    this.appendEventInMemory({
      type: "session.transcript.replaced",
      sessionId: input.sessionId,
      payload: { messages: clone(messages), parts: clone(parts) },
    });
    this.save();
    return { messages: clone(messages), parts: clone(parts) };
  }

  upsertMessagePart(input: UpsertMessagePartInput): SessionMessagePartRecord {
    const session = assertSession(this.state, input.sessionId);
    const message = assertMessage(this.state, input.messageId);
    if (message.sessionId !== input.sessionId) {
      throw new Error(
        `Session message ${input.messageId} does not belong to session ${input.sessionId}`,
      );
    }
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const existing = this.state.parts[id];
    const row: SessionMessagePartRecord = existing
      ? {
          ...existing,
          type: input.type,
          status: input.status ?? existing.status,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined
            ? { toolUseId: input.toolUseId }
            : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.mediaType !== undefined
            ? { mediaType: input.mediaType }
            : {}),
          ...(input.sizeBytes !== undefined
            ? { sizeBytes: input.sizeBytes }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.representationId !== undefined
            ? { representationId: input.representationId }
            : {}),
          ...(input.processor !== undefined
            ? { processor: input.processor }
            : {}),
          ...(input.transformationError !== undefined
            ? { transformationError: input.transformationError }
            : {}),
          metadata: input.metadata
            ? { ...existing.metadata, ...input.metadata }
            : existing.metadata,
          updatedAt: timestamp,
        }
      : {
          id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          seq: maxSeq(this.state.parts, input.sessionId) + 1,
          type: input.type,
          status: input.status ?? "pending",
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined
            ? { toolUseId: input.toolUseId }
            : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.mediaType !== undefined
            ? { mediaType: input.mediaType }
            : {}),
          ...(input.sizeBytes !== undefined
            ? { sizeBytes: input.sizeBytes }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.representationId !== undefined
            ? { representationId: input.representationId }
            : {}),
          ...(input.processor !== undefined
            ? { processor: input.processor }
            : {}),
          ...(input.transformationError !== undefined
            ? { transformationError: input.transformationError }
            : {}),
          metadata: input.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    this.state.parts[id] = row;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.mutations.parts.add(id);
    this.mutations.messages.add(message.id);
    this.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.message.part.updated",
      sessionId: input.sessionId,
      payload: { part: clone(row) },
    });
    this.save();
    return clone(row);
  }

  appendMessagePartDelta(
    input: AppendMessagePartDeltaInput,
  ): SessionEventRecord {
    const session = assertSession(this.state, input.sessionId);
    const message = assertMessage(this.state, input.messageId);
    const part = this.state.parts[input.partId];
    if (!part)
      throw new Error(`Session message part not found: ${input.partId}`);
    if (
      message.sessionId !== input.sessionId ||
      part.sessionId !== input.sessionId ||
      part.messageId !== input.messageId
    ) {
      throw new Error(
        `Session message part ${input.partId} does not belong to message ${input.messageId}`,
      );
    }

    const timestamp = now();
    const event = this.appendEventInMemory(
      {
        type: "session.message.part.delta",
        sessionId: input.sessionId,
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          partId: input.partId,
          field: input.field,
          delta: input.delta,
        },
      },
      false,
    );
    part.text = `${part.text ?? ""}${input.delta}`;
    part.updatedAt = timestamp;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.dirtyDeltaPartIds.add(part.id);
    this.pendingDeltaBytes += Buffer.byteLength(input.delta, "utf8");
    if (this.transactionDepth === 0) {
      if (this.pendingDeltaBytes >= this.deltaFlushBytes)
        this.flushMessagePartDeltas();
      else this.scheduleDeltaFlush();
    }
    return clone(event);
  }

  flushMessagePartDeltas(): void {
    if (this.dirtyDeltaPartIds.size === 0) return;
    const partIds = [...this.dirtyDeltaPartIds];
    const flush = () => this.persistDeltaPartRows(partIds);
    if (this.transactionDepth > 0) flush();
    else this.database.transaction(flush)();
    for (const partId of partIds) this.dirtyDeltaPartIds.delete(partId);
    if (this.dirtyDeltaPartIds.size === 0) {
      this.pendingDeltaBytes = 0;
      this.clearDeltaFlushTimer();
    }
  }

  listMessageParts(
    sessionId: string,
    options: ListMessagePartsOptions = {},
  ): SessionMessagePartRecord[] {
    assertSession(this.state, sessionId);
    let parts = Object.values(this.state.parts)
      .filter((part) => part.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.messageId)
      parts = parts.filter((part) => part.messageId === options.messageId);
    if (options.afterSeq !== undefined)
      parts = parts.filter((part) => part.seq > options.afterSeq!);
    if (options.limit !== undefined) parts = parts.slice(0, options.limit);
    return clone(parts);
  }

  appendEvent(input: AppendEventInput): SessionEventRecord {
    if (input.sessionId) assertSession(this.state, input.sessionId);
    const event = this.appendEventInMemory(input);
    this.save();
    return clone(event);
  }

  listEvents(options: ListEventsOptions = {}): SessionEventRecord[] {
    let events = this.state.events;
    if (options.afterSeq !== undefined)
      events = events.filter((event) => event.seq > options.afterSeq!);
    if (options.sessionId) {
      events = events.filter(
        (event) =>
          event.sessionId === undefined ||
          event.sessionId === options.sessionId,
      );
    }
    events = events.sort((a, b) => a.seq - b.seq);
    if (options.limit !== undefined) events = events.slice(0, options.limit);
    return clone(events);
  }

  latestEventSeq(): number {
    return this.state.nextEventSeq - 1;
  }

  createProjectionSettlement(
    input: CreateProjectionSettlementInput,
  ): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    const existing = this.database
      .prepare(
        `
      SELECT * FROM projection_settlement
      WHERE projector = ? AND root_session_id = ? AND event_sequence = ?
    `,
      )
      .get(input.projector, input.rootSessionId, input.eventSequence) as
      Record<string, unknown> | undefined;
    if (existing) {
      const record = projectionSettlementFromRow(existing);
      if (
        record.action !== input.action ||
        !isDeepStrictEqual(record.payload, input.payload)
      ) {
        throw new Error(
          `Projection settlement identity conflict: ${input.projector}/${input.rootSessionId}/${input.eventSequence}`,
        );
      }
      return record;
    }
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        `
      INSERT INTO projection_settlement
        (id, projector, root_session_id, event_sequence, action, payload_json,
         status, attempt_count, last_error, next_retry_at, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)
    `,
      )
      .run(
        id,
        input.projector,
        input.rootSessionId,
        input.eventSequence,
        input.action,
        encode(input.payload),
        input.error ?? null,
        timestamp,
        timestamp,
      );
    return this.getProjectionSettlement(id)!;
  }

  getProjectionSettlement(id: string): ProjectionSettlementRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM projection_settlement WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? projectionSettlementFromRow(row) : undefined;
  }

  listProjectionSettlements(
    options: ListProjectionSettlementsOptions = {},
  ): ProjectionSettlementRecord[] {
    let records = (
      this.database
        .prepare("SELECT * FROM projection_settlement ORDER BY created_at, id")
        .all() as Array<Record<string, unknown>>
    ).map(projectionSettlementFromRow);
    if (options.projector)
      records = records.filter((row) => row.projector === options.projector);
    if (options.rootSessionId)
      records = records.filter(
        (row) => row.rootSessionId === options.rootSessionId,
      );
    if (options.status) {
      const statuses = new Set(
        Array.isArray(options.status) ? options.status : [options.status],
      );
      records = records.filter((row) => statuses.has(row.status));
    }
    return records;
  }

  markProjectionSettlementRetrying(id: string): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    const timestamp = now();
    const result = this.database
      .prepare(
        `
      UPDATE projection_settlement
      SET status = 'retrying', attempt_count = attempt_count + 1,
          last_error = NULL, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retrying')
    `,
      )
      .run(timestamp, id);
    if (result.changes === 0) {
      const existing = this.getProjectionSettlement(id);
      if (!existing) throw new Error(`Projection settlement not found: ${id}`);
      return existing;
    }
    return this.getProjectionSettlement(id)!;
  }

  failProjectionSettlement(
    id: string,
    error: string,
    nextRetryAt?: number,
  ): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    const result = this.database
      .prepare(
        `
      UPDATE projection_settlement
      SET status = 'pending', last_error = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ? AND status != 'resolved' AND status != 'abandoned'
    `,
      )
      .run(error, nextRetryAt ?? null, now(), id);
    if (result.changes === 0 && !this.getProjectionSettlement(id)) {
      throw new Error(`Projection settlement not found: ${id}`);
    }
    return this.getProjectionSettlement(id)!;
  }

  resolveProjectionSettlement(id: string): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    const timestamp = now();
    const result = this.database
      .prepare(
        `
      UPDATE projection_settlement
      SET status = 'resolved', last_error = NULL, next_retry_at = NULL,
          updated_at = ?, resolved_at = COALESCE(resolved_at, ?)
      WHERE id = ? AND status != 'abandoned'
    `,
      )
      .run(timestamp, timestamp, id);
    if (result.changes === 0 && !this.getProjectionSettlement(id)) {
      throw new Error(`Projection settlement not found: ${id}`);
    }
    return this.getProjectionSettlement(id)!;
  }

  abandonProjectionSettlement(
    id: string,
    error: string,
  ): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    const result = this.database
      .prepare(
        `
      UPDATE projection_settlement
      SET status = 'abandoned', last_error = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status != 'resolved'
    `,
      )
      .run(error, now(), id);
    if (result.changes === 0 && !this.getProjectionSettlement(id)) {
      throw new Error(`Projection settlement not found: ${id}`);
    }
    return this.getProjectionSettlement(id)!;
  }

  createGoal(input: CreateSessionGoalStoreInput): SessionGoal {
    this.assertCurrentOwner();
    const session = assertSession(this.state, input.sessionId);
    assertMutableSession(session);
    const id = input.id ?? randomUUID();
    const timestamp = now();
    try {
      this.database
        .prepare(
          `
        INSERT INTO session_goal (
          id, session_id, objective, plugin_id, revision, status, max_auto_turns,
          auto_turns_used, no_progress_count, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 'active', ?, 0, 0, '[]', ?, ?)
      `,
        )
        .run(
          id,
          input.sessionId,
          input.objective,
          input.pluginId ?? null,
          input.maxAutoTurns,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (String(error).includes("session_goal_session_open_unique")) {
        throw new Error(`Session already has an open goal: ${input.sessionId}`);
      }
      throw error;
    }
    const goal = this.getGoal(id)!;
    this.appendEvent({
      type: "session.goal.created",
      sessionId: input.sessionId,
      payload: { goal },
    });
    return goal;
  }

  getGoalRequest(requestId: string): SessionGoalRequestRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM session_goal_request WHERE request_id = ?`)
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      requestId: String(row.request_id),
      sessionId: String(row.session_id),
      fingerprint: String(row.fingerprint),
      status: String(row.status) as SessionGoalRequestRecord["status"],
      ...(typeof row.goal_id === "string" ? { goalId: row.goal_id } : {}),
      ...(typeof row.result_json === "string"
        ? { result: JSON.parse(row.result_json) as Record<string, unknown> }
        : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  beginGoalRequest(input: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
  }): SessionGoalRequestRecord {
    this.assertCurrentOwner();
    const existing = this.getGoalRequest(input.requestId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.fingerprint !== input.fingerprint
      )
        throw new Error("session_goal_request_conflict");
      return existing;
    }
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO session_goal_request (request_id, session_id, fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.requestId,
        input.sessionId,
        input.fingerprint,
        timestamp,
        timestamp,
      );
    return this.getGoalRequest(input.requestId)!;
  }

  settleGoalRequest(
    requestId: string,
    input: {
      status: "pending" | "completed" | "failed";
      goalId?: string;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): SessionGoalRequestRecord {
    this.assertCurrentOwner();
    const timestamp = now();
    const result = this.database
      .prepare(
        `UPDATE session_goal_request SET status = ?, goal_id = ?, result_json = ?, error = ?, updated_at = ? WHERE request_id = ?`,
      )
      .run(
        input.status,
        input.goalId ?? null,
        input.result ? JSON.stringify(input.result) : null,
        input.error ?? null,
        timestamp,
        requestId,
      );
    if (result.changes !== 1)
      throw new Error(`Session goal request not found: ${requestId}`);
    return this.getGoalRequest(requestId)!;
  }

  recordGoalAssessment(input: {
    goalId: string;
    revision: number;
    runId: string;
    assessment: Record<string, unknown>;
  }): void {
    this.assertCurrentOwner();
    this.database
      .prepare(
        `
      INSERT INTO session_goal_assessment (id, goal_id, revision, run_id, assessment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, revision, run_id) DO UPDATE SET assessment_json = excluded.assessment_json
    `,
      )
      .run(
        randomUUID(),
        input.goalId,
        input.revision,
        input.runId,
        JSON.stringify(input.assessment),
        now(),
      );
  }

  goalEvidenceSignatures(goalId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT assessment_json FROM session_goal_assessment WHERE goal_id = ?`,
      )
      .all(goalId) as { assessment_json: string }[];
    return rows.flatMap((row) => {
      const value = JSON.parse(row.assessment_json) as {
        verifiedSignatures?: string[];
      };
      return value.verifiedSignatures ?? [];
    });
  }

  recordGoalContinuation(input: {
    goalId: string;
    revision: number;
    previousRunId: string;
    inputId: string;
    runId: string;
  }): boolean {
    this.assertCurrentOwner();
    const timestamp = now();
    const result = this.database
      .prepare(
        `
      INSERT OR IGNORE INTO session_goal_continuation
        (id, goal_id, revision, previous_run_id, input_id, run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
      )
      .run(
        randomUUID(),
        input.goalId,
        input.revision,
        input.previousRunId,
        input.inputId,
        input.runId,
        timestamp,
        timestamp,
      );
    return result.changes === 1;
  }

  pauseActiveGoalsOnStartup(): number {
    this.assertCurrentOwner();
    return this.transaction(() => {
      const rows = this.database
        .prepare(`SELECT id FROM session_goal WHERE status = 'active'`)
        .all() as { id: string }[];
      for (const { id } of rows) {
        const goal = this.getGoal(id)!;
        this.updateGoal(id, {
          expectedRevision: goal.revision,
          status: "paused",
          currentRunId: null,
          reason: "应用重启后需要手动继续",
        });
      }
      this.database
        .prepare(
          `UPDATE session_goal_continuation SET status = 'cancelled', updated_at = ? WHERE status = 'pending'`,
        )
        .run(now());
      return rows.length;
    });
  }

  markGoalContinuation(
    runId: string,
    status: "dispatched" | "cancelled",
  ): void {
    this.assertCurrentOwner();
    this.database
      .prepare(
        `UPDATE session_goal_continuation SET status = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(status, now(), runId);
  }

  finishGoalRun(runId: string): void {
    this.assertCurrentOwner();
    const row = this.database
      .prepare(`SELECT id FROM session_goal WHERE current_run_id = ?`)
      .get(runId) as { id: string } | undefined;
    if (!row) return;
    this.database
      .prepare(
        `UPDATE session_goal SET current_run_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now(), row.id);
    const goal = this.getGoal(row.id)!;
    this.appendEvent({
      type: "session.goal.updated",
      sessionId: goal.sessionId,
      payload: { goal },
    });
  }

  startGoalRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): boolean {
    this.assertCurrentOwner();
    return this.transaction(() => {
      const goal = this.getGoal(goalId);
      if (!goal || goal.status !== "active" || goal.revision !== revision)
        return false;
      const run = this.getRun(runId);
      if (
        !run ||
        run.sessionId !== goal.sessionId ||
        (run.status !== "pending" && run.status !== "running")
      )
        return false;
      if (goal.currentRunId === runId) return true;
      if (automatic && goal.autoTurnsUsed >= goal.maxAutoTurns) {
        this.updateGoal(goalId, {
          expectedRevision: revision,
          status: "paused",
          reason: "目标自动续跑额度已用完",
          currentRunId: null,
        });
        return false;
      }
      // Starting a run changes accounting, not the objective revision the run is bound to.
      this.database
        .prepare(
          `UPDATE session_goal SET current_run_id = ?, auto_turns_used = auto_turns_used + ?, updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(runId, automatic ? 1 : 0, now(), goalId, revision);
      this.appendEvent({
        type: "session.goal.updated",
        sessionId: goal.sessionId,
        payload: { goal: this.getGoal(goalId)! },
      });
      return true;
    });
  }

  getGoal(id: string): SessionGoal | undefined {
    const row = this.database
      .prepare(`SELECT * FROM session_goal WHERE id = ?`)
      .get(id);
    return row ? sessionGoalFromRow(row as Record<string, unknown>) : undefined;
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    const row = this.database
      .prepare(
        `
      SELECT * FROM session_goal
      WHERE session_id = ?
      ORDER BY CASE WHEN status IN ('active','waiting_user','blocked','paused') THEN 0 ELSE 1 END,
               updated_at DESC
      LIMIT 1
    `,
      )
      .get(sessionId);
    return row ? sessionGoalFromRow(row as Record<string, unknown>) : undefined;
  }

  updateGoal(id: string, input: UpdateSessionGoalStoreInput): SessionGoal {
    this.assertCurrentOwner();
    const current = this.getGoal(id);
    if (!current) throw new Error(`Session goal not found: ${id}`);
    if (current.revision !== input.expectedRevision)
      throw new Error("session_goal_revision_conflict");
    const nextRevision = current.revision + 1;
    const timestamp = now();
    const next = {
      objective: input.objective ?? current.objective,
      pluginId: input.pluginId ?? current.pluginId,
      status: input.status ?? current.status,
      maxAutoTurns: input.maxAutoTurns ?? current.maxAutoTurns,
      autoTurnsUsed: input.autoTurnsUsed ?? current.autoTurnsUsed,
      noProgressCount: input.noProgressCount ?? current.noProgressCount,
      blockerKey:
        input.blockerKey === undefined
          ? current.blockerKey
          : (input.blockerKey ?? undefined),
      currentRunId:
        input.currentRunId === undefined
          ? current.currentRunId
          : (input.currentRunId ?? undefined),
      reason:
        input.reason === undefined
          ? current.reason
          : (input.reason ?? undefined),
      wait: input.wait === undefined ? current.wait : (input.wait ?? undefined),
      evidence: input.evidence ?? current.evidence,
      assessment:
        input.assessment === undefined
          ? current.assessment
          : (input.assessment ?? undefined),
    };
    const result = this.database
      .prepare(
        `
      UPDATE session_goal SET objective = ?, plugin_id = ?, revision = ?, status = ?, max_auto_turns = ?,
        auto_turns_used = ?, no_progress_count = ?, blocker_key = ?, current_run_id = ?, reason = ?,
        wait_json = ?, evidence_json = ?, last_assessment_json = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `,
      )
      .run(
        next.objective,
        next.pluginId ?? null,
        nextRevision,
        next.status,
        next.maxAutoTurns,
        next.autoTurnsUsed,
        next.noProgressCount,
        next.blockerKey ?? null,
        next.currentRunId ?? null,
        next.reason ?? null,
        next.wait ? JSON.stringify(next.wait) : null,
        JSON.stringify(next.evidence),
        next.assessment ? JSON.stringify(next.assessment) : null,
        timestamp,
        id,
        input.expectedRevision,
      );
    if (result.changes !== 1) throw new Error("session_goal_revision_conflict");
    const goal = this.getGoal(id)!;
    this.appendEvent({
      type: "session.goal.updated",
      sessionId: goal.sessionId,
      payload: { goal },
    });
    return goal;
  }

  createRun(input: CreateRunInput): SessionRunRecord {
    const session = assertSession(this.state, input.sessionId);
    assertMutableSession(session);
    if (input.inputId && !this.state.inputs[input.inputId]) {
      throw new Error(`Session input not found: ${input.inputId}`);
    }
    if (
      input.inputId &&
      this.state.inputs[input.inputId]!.sessionId !== input.sessionId
    ) {
      throw new Error(
        `Session input does not belong to session: ${input.inputId}`,
      );
    }
    const id = input.id ?? randomUUID();
    if (this.state.runs[id])
      throw new Error(`Session run already exists: ${id}`);
    const timestamp = now();
    const run: SessionRunRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      status: "pending",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.runs[id] = run;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.mutations.runs.add(id);
    this.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.run.created",
      sessionId: input.sessionId,
      payload: { run },
    });
    this.save();
    return clone(run);
  }

  updateRun(runId: string, input: UpdateRunInput): SessionRunRecord {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`Session run not found: ${runId}`);
    const session = assertSession(this.state, run.sessionId);
    const timestamp = now();
    const previous = run.status;
    if (input.status) {
      if (isTerminalRunStatus(previous) && input.status !== previous) {
        throw new Error(`Session run is already terminal: ${runId}`);
      }
      run.status = input.status;
      if (input.status === "running" && previous !== "running") {
        run.startedAt = timestamp;
        delete run.finishedAt;
        delete run.error;
      }
      if (["completed", "failed", "interrupted"].includes(input.status))
        run.finishedAt = timestamp;
    }
    if (input.error !== undefined) run.error = input.error;
    if (input.metadata) run.metadata = { ...run.metadata, ...input.metadata };
    run.updatedAt = timestamp;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.mutations.runs.add(runId);
    this.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.run.updated",
      sessionId: run.sessionId,
      payload: { run, previousStatus: previous },
    });
    this.save();
    return clone(run);
  }

  getRun(runId: string): SessionRunRecord | undefined {
    const run = this.state.runs[runId];
    return run ? clone(run) : undefined;
  }

  findRunByInput(inputId: string): SessionRunRecord | undefined {
    const direct = this.findOwningRunByInput(inputId);
    if (direct) return clone(direct);
    const promoted = Object.values(this.state.messages).find(
      (message) => message.inputId === inputId && message.runId,
    );
    const run = promoted?.runId ? this.state.runs[promoted.runId] : undefined;
    return run ? clone(run) : undefined;
  }

  listRunsByInput(inputId: string): SessionRunRecord[] {
    return clone(
      Object.values(this.state.runs)
        .filter((candidate) => candidate.inputId === inputId)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        ),
    );
  }

  findOwningRunByInput(inputId: string): SessionRunRecord | undefined {
    return this.listRunsByInput(inputId)[0];
  }

  listRuns(sessionId: string): SessionRunRecord[] {
    assertSession(this.state, sessionId);
    return clone(
      Object.values(this.state.runs)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  createSessionTask(input: CreateSessionTaskInput): SessionExecutionRecord {
    const session = assertSession(this.state, input.sessionId);
    if (
      (input.requestNamespace === undefined) !==
      (input.requestId === undefined)
    ) {
      throw new Error(
        "Session task requestNamespace and requestId must be provided together",
      );
    }
    if (input.requestNamespace && input.requestId) {
      const existing = Object.values(this.state.tasks).find(
        (task) =>
          task.sessionId === input.sessionId &&
          task.requestNamespace === input.requestNamespace &&
          task.requestId === input.requestId,
      );
      if (existing)
        throw new Error(`Session task request already exists: ${existing.id}`);
    }
    const id = input.id ?? randomUUID();
    if (this.state.tasks[id])
      throw new Error(`Session task already exists: ${id}`);
    if (input.childSessionId) {
      const child = assertSession(this.state, input.childSessionId);
      if (child.parentId !== input.sessionId) {
        throw new Error(
          `Child session does not belong to task session: ${input.childSessionId}`,
        );
      }
    }
    if (input.runId) {
      const run = this.state.runs[input.runId];
      if (
        !run ||
        (run.sessionId !== input.childSessionId &&
          run.sessionId !== input.sessionId)
      ) {
        throw new Error(
          `Task run does not belong to task session: ${input.runId}`,
        );
      }
    }
    const timestamp = now();
    const task: SessionExecutionRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.requestNamespace
        ? { requestNamespace: input.requestNamespace }
        : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      type: input.type,
      status: input.status ?? "running",
      description: input.description,
      cwd: resolve(input.cwd),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      ...((input.status ?? "running") === "running"
        ? { startedAt: timestamp }
        : {}),
      updatedAt: timestamp,
    };
    this.state.tasks[id] = task;
    session.updatedAt = timestamp;
    this.mutations.tasks.add(id);
    this.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.task.created",
      sessionId: task.sessionId,
      payload: { task },
    });
    this.save();
    this.notifySessionTask(id);
    return clone(task);
  }

  /** Atomically reserves one durable task for a producer request. */
  reserveSessionTask(
    input: CreateSessionTaskInput & {
      requestNamespace: string;
      requestId: string;
    },
  ): { task: SessionExecutionRecord; created: boolean } {
    const existing = Object.values(this.state.tasks).find(
      (task) =>
        task.sessionId === input.sessionId &&
        task.requestNamespace === input.requestNamespace &&
        task.requestId === input.requestId,
    );
    if (existing) return { task: clone(existing), created: false };
    return {
      task: this.createSessionTask({ ...input, status: "pending" }),
      created: true,
    };
  }

  /**
   * Confirms or fails an admitted task only while it is still pending.
   * The check and update are synchronous so a concurrent stop cannot be
   * overwritten by a stale process-start result.
   */
  transitionPendingSessionTask(
    taskId: string,
    input: UpdateSessionTaskInput,
  ): { task: SessionExecutionRecord; transitioned: boolean } {
    const current = this.state.tasks[taskId];
    if (!current) throw new Error(`Session task not found: ${taskId}`);
    if (current.status !== "pending") {
      return { task: clone(current), transitioned: false };
    }
    return { task: this.updateSessionTask(taskId, input), transitioned: true };
  }

  updateSessionTask(
    taskId: string,
    input: UpdateSessionTaskInput,
  ): SessionExecutionRecord {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Session task not found: ${taskId}`);
    const session = assertSession(this.state, task.sessionId);
    if (input.runId !== undefined) {
      const run = this.state.runs[input.runId];
      if (
        !run ||
        (run.sessionId !== task.sessionId &&
          run.sessionId !== task.childSessionId)
      ) {
        throw new Error(`Task run does not belong to task: ${input.runId}`);
      }
      task.runId = input.runId;
    }
    const timestamp = now();
    const previousStatus = task.status;
    if (input.status) {
      task.status = input.status;
      if (input.status === "running" && previousStatus !== "running") {
        task.startedAt = timestamp;
        delete task.finishedAt;
        delete task.output;
        delete task.error;
      }
      if (
        ["completed", "failed", "stopped", "interrupted"].includes(input.status)
      )
        task.finishedAt = timestamp;
    }
    if (input.output !== undefined) task.output = input.output;
    if (input.error !== undefined) task.error = input.error;
    if (input.metadata) task.metadata = { ...task.metadata, ...input.metadata };
    task.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.mutations.tasks.add(taskId);
    this.mutations.sessions.add(session.id);
    this.appendEventInMemory({
      type: "session.task.updated",
      sessionId: task.sessionId,
      payload: { task, previousStatus },
    });
    this.save();
    this.notifySessionTask(taskId);
    return clone(task);
  }

  getSessionTask(taskId: string): SessionExecutionRecord | undefined {
    const task = this.state.tasks[taskId];
    return task ? clone(task) : undefined;
  }

  listSessionTasks(sessionId: string): SessionExecutionRecord[] {
    assertSession(this.state, sessionId);
    return clone(
      Object.values(this.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  findSessionExecutionByRuntimeId(
    sessionId: string,
    runtimeExecutionId: string,
  ): SessionExecutionRecord | undefined {
    assertSession(this.state, sessionId);
    const task = Object.values(this.state.tasks).find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        (candidate.metadata.runtimeExecutionId === runtimeExecutionId ||
          candidate.metadata.taskManagerId === runtimeExecutionId),
    );
    return task ? clone(task) : undefined;
  }

  /** A daemon restart cannot retain child Agent callbacks or detached process handles. */
  interruptActiveSessionTasks(
    reason = "Daemon restarted before the task completed",
  ): number {
    const active = Object.values(this.state.tasks).filter(
      (task) => task.status === "pending" || task.status === "running",
    );
    for (const task of active) {
      this.updateSessionTask(task.id, { status: "interrupted", error: reason });
    }
    return active.length;
  }

  /**
   * Mark work owned by a previous daemon process as terminal. A fresh daemon
   * cannot resume an in-memory QueryEngine run, so leaving these rows active
   * would keep every attached client permanently busy.
   */
  interruptActiveRuns(
    reason = "Daemon restarted before the run completed",
  ): number {
    const active = Object.values(this.state.runs).filter(
      (run) => run.status === "pending" || run.status === "running",
    );
    for (const run of active) {
      const messageIds = new Set(
        Object.values(this.state.messages)
          .filter((message) => message.runId === run.id)
          .map((message) => message.id),
      );
      for (const part of Object.values(this.state.parts)) {
        if (!messageIds.has(part.messageId) || part.status !== "running")
          continue;
        this.upsertMessagePart({
          id: part.id,
          sessionId: part.sessionId,
          messageId: part.messageId,
          type: part.type,
          status: part.type === "tool" ? "failed" : "interrupted",
          ...(part.type === "tool"
            ? {
                metadata: {
                  ...part.metadata,
                  toolCallId: part.toolUseId ?? part.id,
                  toolAttemptId:
                    typeof part.metadata.toolAttemptId === "string"
                      ? part.metadata.toolAttemptId
                      : `tool_attempt_${part.toolUseId ?? part.id}_1`,
                  outcome: "unknown",
                  failureKind: "unknown_outcome",
                  outcomeWarning:
                    "Tool may already have executed; automatic retry is disabled",
                },
              }
            : {}),
        });
      }
      this.transaction(() => {
        this.settleActiveRunAttempts(run.id, "cancelled", reason);
        this.updateRun(run.id, { status: "interrupted", error: reason });
      });
    }
    return active.length;
  }

  async waitForSessionTaskChange(
    taskId: string,
    after: number,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<SessionExecutionRecord | undefined> {
    const current = this.getSessionTask(taskId);
    if (!current || current.updatedAt > after) return current;
    return await new Promise((resolvePromise, reject) => {
      const listeners = this.taskListeners.get(taskId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        listeners.delete(changed);
        options.signal?.removeEventListener("abort", aborted);
        if (listeners.size === 0) this.taskListeners.delete(taskId);
      };
      const changed = () => {
        finish();
        resolvePromise(this.getSessionTask(taskId));
      };
      const aborted = () => {
        finish();
        reject(
          options.signal?.reason ?? new Error("Session task wait aborted."),
        );
      };
      listeners.add(changed);
      this.taskListeners.set(taskId, listeners);
      if (options.signal?.aborted) {
        aborted();
        return;
      }
      options.signal?.addEventListener("abort", aborted, { once: true });
      const registered = this.getSessionTask(taskId);
      if (!registered || registered.updatedAt > after) {
        changed();
        return;
      }
      timer = setTimeout(
        () => {
          finish();
          resolvePromise(this.getSessionTask(taskId));
        },
        Math.max(1, options.timeoutMs),
      );
      timer.unref?.();
    });
  }

  private notifySessionTask(taskId: string): void {
    for (const listener of [...(this.taskListeners.get(taskId) ?? [])])
      listener();
  }

  createRunAttempt(input: CreateRunAttemptInput): SessionRunAttemptRecord {
    const run = this.state.runs[input.runId];
    if (!run) throw new Error(`Session run not found: ${input.runId}`);
    if (isTerminalRunStatus(run.status))
      throw new Error(`Session run is already terminal: ${input.runId}`);
    const attempts = Object.values(this.state.attempts).filter(
      (attempt) => attempt.runId === input.runId,
    );
    const sequence =
      input.sequence ??
      attempts.reduce((max, attempt) => Math.max(max, attempt.sequence), 0) + 1;
    if (attempts.some((attempt) => attempt.sequence === sequence)) {
      throw new Error(
        `Session run attempt sequence already exists: ${input.runId}/${sequence}`,
      );
    }
    const id = input.id ?? `attempt_${randomUUID()}`;
    if (this.state.attempts[id])
      throw new Error(`Session run attempt already exists: ${id}`);
    const timestamp = now();
    const attempt: SessionRunAttemptRecord = {
      id,
      runId: input.runId,
      sequence,
      status: "pending",
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.retryReason ? { retryReason: input.retryReason } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.attempts[id] = attempt;
    this.mutations.attempts.add(id);
    this.appendEventInMemory({
      type: "session.run_attempt.created",
      sessionId: run.sessionId,
      payload: { attempt },
    });
    this.save();
    return clone(attempt);
  }

  updateRunAttempt(
    attemptId: string,
    input: UpdateRunAttemptInput,
  ): SessionRunAttemptRecord {
    const attempt = this.state.attempts[attemptId];
    if (!attempt)
      throw new Error(`Session run attempt not found: ${attemptId}`);
    const run = this.state.runs[attempt.runId];
    if (!run) throw new Error(`Session run not found: ${attempt.runId}`);
    const previous = attempt.status;
    const timestamp = now();
    if (input.status) {
      if (isTerminalAttemptStatus(previous) && input.status !== previous) {
        throw new Error(
          `Session run attempt is already terminal: ${attemptId}`,
        );
      }
      attempt.status = input.status;
      if (input.status === "running" && previous !== "running") {
        attempt.startedAt = timestamp;
        delete attempt.finishedAt;
        delete attempt.error;
        delete attempt.errorKind;
      }
      if (isTerminalAttemptStatus(input.status)) attempt.finishedAt = timestamp;
    }
    if (input.errorKind !== undefined) attempt.errorKind = input.errorKind;
    if (input.error !== undefined) attempt.error = input.error;
    if (input.inputTokens !== undefined)
      attempt.inputTokens = input.inputTokens;
    if (input.outputTokens !== undefined)
      attempt.outputTokens = input.outputTokens;
    attempt.updatedAt = timestamp;
    this.mutations.attempts.add(attemptId);
    this.appendEventInMemory({
      type: "session.run_attempt.updated",
      sessionId: run.sessionId,
      payload: { attempt, previousStatus: previous },
    });
    this.save();
    return clone(attempt);
  }

  getRunAttempt(attemptId: string): SessionRunAttemptRecord | undefined {
    const attempt = this.state.attempts[attemptId];
    return attempt ? clone(attempt) : undefined;
  }

  listRunAttempts(runId: string): SessionRunAttemptRecord[] {
    if (!this.state.runs[runId])
      throw new Error(`Session run not found: ${runId}`);
    return clone(
      Object.values(this.state.attempts)
        .filter((attempt) => attempt.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
    );
  }

  settleActiveRunAttempts(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): number {
    const active = Object.values(this.state.attempts).filter(
      (attempt) =>
        attempt.runId === runId && !isTerminalAttemptStatus(attempt.status),
    );
    for (const attempt of active) {
      this.updateRunAttempt(attempt.id, {
        status,
        ...(error
          ? {
              error,
              errorKind: status === "cancelled" ? "interrupted" : "provider",
            }
          : {}),
      });
    }
    return active.length;
  }

  /**
   * A durable input without either a primary run or transcript ownership may
   * have been left between admission and live delivery by a previous daemon.
   * Give it a terminal owner without replaying the model or any tool effect.
   */
  terminalizeUnownedInputs(
    reason = "Daemon restarted before the input was assigned to a run",
  ): number {
    return this.transaction(() => {
      const unowned = Object.values(this.state.inputs).filter((input) => {
        const session = this.state.sessions[input.sessionId];
        return (
          session !== undefined &&
          session.status !== "archived" &&
          session.status !== "closing" &&
          this.findRunByInput(input.id) === undefined
        );
      });
      for (const input of unowned) {
        const traceId =
          typeof input.metadata.traceId === "string"
            ? input.metadata.traceId
            : undefined;
        const run = this.createRun({
          sessionId: input.sessionId,
          inputId: input.id,
          metadata: {
            ...(traceId ? { traceId } : {}),
            recovery: {
              kind: "orphan_input",
              inputId: input.id,
              delivery: input.delivery,
              reason,
            },
          },
        });
        this.updateRun(run.id, { status: "interrupted", error: reason });
      }
      return unowned.length;
    });
  }

  /** A previous process cannot retain the resolver behind a pending permission prompt. */
  expirePendingPermissionRequests(
    reason = "Daemon restarted before the permission was resolved",
  ): number {
    const pending = Object.values(this.state.permissions).filter(
      (request) => request.status === "pending",
    );
    for (const request of pending) {
      this.replyPermission({
        requestId: request.id,
        status: "expired",
        decision: reason,
      });
    }
    return pending.length;
  }

  /** Complete an archive that was interrupted by a daemon process exit. */
  finalizeClosingSessions(): number {
    const closing = Object.values(this.state.sessions).filter(
      (session) => session.status === "closing",
    );
    for (const session of closing) {
      const hasActiveRun = Object.values(this.state.runs).some(
        (run) =>
          run.sessionId === session.id &&
          (run.status === "pending" || run.status === "running"),
      );
      if (!hasActiveRun) this.archiveSession(session.id);
    }
    return closing.length;
  }

  createPermissionRequest(
    input: CreatePermissionRequestInput,
  ): PermissionRequestRecord {
    assertSession(this.state, input.sessionId);
    if (input.runId && !this.state.runs[input.runId])
      throw new Error(`Session run not found: ${input.runId}`);
    const id = input.id ?? randomUUID();
    if (this.state.permissions[id])
      throw new Error(`Permission request already exists: ${id}`);
    const timestamp = now();
    const request: PermissionRequestRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      toolName: input.toolName,
      payload: input.payload ?? {},
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.permissions[id] = request;
    this.mutations.permissions.add(id);
    this.appendEventInMemory({
      type: "permission.asked",
      sessionId: input.sessionId,
      payload: { request },
    });
    this.save();
    return clone(request);
  }

  replyPermission(input: ReplyPermissionInput): PermissionRequestRecord {
    const request = this.state.permissions[input.requestId];
    if (!request)
      throw new Error(`Permission request not found: ${input.requestId}`);
    if (request.status !== "pending")
      throw new Error(
        `Permission request already resolved: ${input.requestId}`,
      );
    const timestamp = now();
    request.status = input.status;
    if (input.decision !== undefined) request.decision = input.decision;
    if (input.clientId !== undefined)
      request.decidedByClientId = input.clientId;
    request.updatedAt = timestamp;
    this.mutations.permissions.add(request.id);
    this.appendEventInMemory({
      type: "permission.replied",
      sessionId: request.sessionId,
      payload: { request },
    });
    this.save();
    return clone(request);
  }

  getPermissionRequest(requestId: string): PermissionRequestRecord | undefined {
    const request = this.state.permissions[requestId];
    return request ? clone(request) : undefined;
  }

  listPermissionRequests(
    options: ListPermissionRequestsOptions = {},
  ): PermissionRequestRecord[] {
    let requests = Object.values(this.state.permissions);
    if (options.sessionId)
      requests = requests.filter(
        (request) => request.sessionId === options.sessionId,
      );
    if (options.status)
      requests = requests.filter(
        (request) => request.status === options.status,
      );
    if (options.toolName)
      requests = requests.filter(
        (request) => request.toolName === options.toolName,
      );
    requests = requests.sort((a, b) => a.createdAt - b.createdAt);
    if (options.limit !== undefined)
      requests = requests.slice(0, options.limit);
    return clone(requests);
  }

  /** Read one session and its canonical children at a single event cursor. */
  getSessionState(sessionId: string): SessionStateSnapshot {
    const session = assertSession(this.state, sessionId);
    return clone({
      cursor: this.state.nextEventSeq - 1,
      session,
      inputs: Object.values(this.state.inputs)
        .filter((input) => input.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      messages: Object.values(this.state.messages)
        .filter((message) => message.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      parts: Object.values(this.state.parts)
        .filter((part) => part.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      runs: Object.values(this.state.runs)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
      attempts: Object.values(this.state.attempts)
        .filter(
          (attempt) => this.state.runs[attempt.runId]?.sessionId === sessionId,
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence),
      tasks: Object.values(this.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
      permissions: Object.values(this.state.permissions)
        .filter((request) => request.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    });
  }

  private appendEventInMemory(
    input: AppendEventInput,
    retain = true,
  ): SessionEventRecord {
    const prepared = this.eventRegistry.prepareWrite(
      input.type,
      input.payload ?? {},
      input.sessionId,
    );
    const event: SessionEventRecord = {
      id: input.id ?? randomUUID(),
      seq: this.allocateEventSequence(),
      type: input.type,
      schemaVersion: prepared.schemaVersion,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      payload: prepared.payload,
      createdAt: now(),
    };
    if (retain) {
      this.state.events.push(event);
      this.mutations.events.add(event.id);
    }
    return event;
  }

  private scheduleDeltaFlush(): void {
    if (
      this.deltaFlushTimer ||
      this.closed ||
      this.dirtyDeltaPartIds.size === 0
    )
      return;
    this.deltaFlushTimer = setTimeout(() => {
      this.deltaFlushTimer = undefined;
      try {
        this.flushMessagePartDeltas();
      } catch {
        this.scheduleDeltaFlush();
      }
    }, this.deltaFlushIntervalMs);
    this.deltaFlushTimer.unref?.();
  }

  private clearDeltaFlushTimer(): void {
    if (!this.deltaFlushTimer) return;
    clearTimeout(this.deltaFlushTimer);
    this.deltaFlushTimer = undefined;
  }

  private clearDirtyDeltas(): void {
    this.dirtyDeltaPartIds.clear();
    this.pendingDeltaBytes = 0;
    this.clearDeltaFlushTimer();
  }

  private restoreDirtyDeltas(partIds: Set<string>, pendingBytes: number): void {
    this.dirtyDeltaPartIds.clear();
    for (const partId of partIds) this.dirtyDeltaPartIds.add(partId);
    this.pendingDeltaBytes = pendingBytes;
    this.clearDeltaFlushTimer();
    this.scheduleDeltaFlush();
  }

  private refreshSessionStatus(session: SessionRecord): void {
    if (session.status === "archived" || session.status === "closing") return;
    const hasActiveRun = Object.values(this.state.runs).some(
      (run) =>
        run.sessionId === session.id &&
        (run.status === "pending" || run.status === "running"),
    );
    session.status = hasActiveRun ? "running" : "idle";
  }

  private collectSessionTreeIds(sessionId: string): string[] {
    const result: string[] = [];
    const visit = (id: string): void => {
      result.push(id);
      for (const child of Object.values(this.state.sessions)
        .filter((session) => session.parentId === id)
        .sort((a, b) => a.createdAt - b.createdAt)) {
        visit(child.id);
      }
    };
    visit(sessionId);
    return result;
  }

  private load(): SessionState {
    const state = emptyState();
    for (const row of this.database
      .prepare("SELECT * FROM session")
      .all() as Array<Record<string, unknown>>) {
      const session: SessionRecord = {
        id: row.id as string,
        ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
        ...(row.project_id ? { projectId: row.project_id as string } : {}),
        cwd: row.cwd as string,
        ...(row.cwd_relative !== null
          ? { cwdRelative: row.cwd_relative as string }
          : {}),
        title: row.title as string,
        model: row.model as string,
        ...(row.agent ? { agent: row.agent as string } : {}),
        status: row.status as SessionRecord["status"],
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}),
      };
      state.sessions[session.id] = session;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_input")
      .all() as Array<Record<string, unknown>>) {
      const input: SessionInputRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        seq: row.seq as number,
        delivery: row.delivery as SessionInputRecord["delivery"],
        ...hydrateInput(row),
        attachments: [],
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
      };
      state.inputs[input.id] = input;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_input_attachment ORDER BY input_id, seq")
      .all() as Array<Record<string, unknown>>) {
      const reference: SessionInputAttachmentRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        inputId: row.input_id as string,
        assetId: row.asset_id as string,
        seq: row.seq as number,
        intent: row.intent as SessionInputAttachmentRecord["intent"],
        displayName: row.display_name as string,
        mediaType: row.media_type as string,
        sizeBytes: row.size_bytes as number,
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
      };
      state.inputAttachments[reference.id] = reference;
      const input = state.inputs[reference.inputId];
      if (input) input.attachments.push(reference);
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_message")
      .all() as Array<Record<string, unknown>>) {
      const message: SessionMessageRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        seq: row.seq as number,
        role: row.role as SessionMessageRecord["role"],
        ...(row.run_id ? { runId: row.run_id as string } : {}),
        ...(row.input_id ? { inputId: row.input_id as string } : {}),
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
      state.messages[message.id] = message;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_message_part")
      .all() as Array<Record<string, unknown>>) {
      const part: SessionMessagePartRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        messageId: row.message_id as string,
        seq: row.seq as number,
        type: row.type as SessionMessagePartRecord["type"],
        status: row.status as SessionMessagePartRecord["status"],
        ...(row.text !== null ? { text: row.text as string } : {}),
        ...(row.tool_use_id ? { toolUseId: row.tool_use_id as string } : {}),
        ...(row.tool_name ? { toolName: row.tool_name as string } : {}),
        ...(row.input_json ? { input: decode(row.input_json as string) } : {}),
        ...(row.output_json
          ? { output: JSON.parse(row.output_json as string) }
          : {}),
        ...(row.is_error !== null ? { isError: Boolean(row.is_error) } : {}),
        ...(row.asset_id ? { assetId: row.asset_id as string } : {}),
        ...(row.attachment_intent
          ? {
              intent:
                row.attachment_intent as SessionMessagePartRecord["intent"],
            }
          : {}),
        ...(row.display_name
          ? { displayName: row.display_name as string }
          : {}),
        ...(row.media_type ? { mediaType: row.media_type as string } : {}),
        ...(row.size_bytes !== null
          ? { sizeBytes: row.size_bytes as number }
          : {}),
        ...(row.transformation_kind
          ? {
              kind: row.transformation_kind as SessionMessagePartRecord["kind"],
            }
          : {}),
        ...(row.representation_id
          ? { representationId: row.representation_id as string }
          : {}),
        ...(row.processor ? { processor: row.processor as string } : {}),
        ...(row.transformation_error
          ? { transformationError: row.transformation_error as string }
          : {}),
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
      state.parts[part.id] = part;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_run")
      .all() as Array<Record<string, unknown>>) {
      const run: SessionRunRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        ...(row.input_id ? { inputId: row.input_id as string } : {}),
        status: row.status as SessionRunRecord["status"],
        ...(row.started_at ? { startedAt: row.started_at as number } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
        ...(row.error ? { error: row.error as string } : {}),
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
      state.runs[run.id] = run;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_run_attempt")
      .all() as Array<Record<string, unknown>>) {
      const attempt: SessionRunAttemptRecord = {
        id: row.id as string,
        runId: row.run_id as string,
        sequence: row.sequence as number,
        status: row.status as SessionRunAttemptRecord["status"],
        ...(row.provider ? { provider: row.provider as string } : {}),
        ...(row.model ? { model: row.model as string } : {}),
        ...(row.retry_reason
          ? { retryReason: row.retry_reason as string }
          : {}),
        ...(row.error_kind ? { errorKind: row.error_kind as string } : {}),
        ...(row.error ? { error: row.error as string } : {}),
        ...(row.input_tokens !== null
          ? { inputTokens: row.input_tokens as number }
          : {}),
        ...(row.output_tokens !== null
          ? { outputTokens: row.output_tokens as number }
          : {}),
        ...(row.started_at ? { startedAt: row.started_at as number } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
      state.attempts[attempt.id] = attempt;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_task")
      .all() as Array<Record<string, unknown>>) {
      const task: SessionExecutionRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        ...(row.request_namespace
          ? { requestNamespace: row.request_namespace as string }
          : {}),
        ...(row.request_id ? { requestId: row.request_id as string } : {}),
        ...(row.child_session_id
          ? { childSessionId: row.child_session_id as string }
          : {}),
        ...(row.run_id ? { runId: row.run_id as string } : {}),
        type: row.type as string,
        status: row.status as SessionExecutionRecord["status"],
        description: row.description as string,
        cwd: row.cwd as string,
        ...(row.output ? { output: row.output as string } : {}),
        ...(row.error ? { error: row.error as string } : {}),
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        ...(row.started_at ? { startedAt: row.started_at as number } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
        updatedAt: row.updated_at as number,
      };
      state.tasks[task.id] = task;
    }
    for (const row of this.database
      .prepare("SELECT * FROM permission_request")
      .all() as Array<Record<string, unknown>>) {
      const request: PermissionRequestRecord = {
        id: row.id as string,
        sessionId: row.session_id as string,
        ...(row.run_id ? { runId: row.run_id as string } : {}),
        toolName: row.tool_name as string,
        payload: decode(row.payload_json as string),
        status: row.status as PermissionRequestRecord["status"],
        ...(row.decision ? { decision: row.decision as string } : {}),
        ...(row.decided_by_client_id
          ? { decidedByClientId: row.decided_by_client_id as string }
          : {}),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
      state.permissions[request.id] = request;
    }
    for (const row of this.database
      .prepare("SELECT * FROM session_event ORDER BY seq")
      .all() as Array<Record<string, unknown>>) {
      const schemaVersion = row.schema_version as number;
      const prepared = this.eventRegistry.prepareRead(
        row.type as string,
        schemaVersion,
        decode(row.payload_json as string),
        row.session_id ? (row.session_id as string) : undefined,
      );
      const event: SessionEventRecord = {
        id: row.id as string,
        seq: row.seq as number,
        type: prepared.type,
        schemaVersion: prepared.schemaVersion,
        ...(row.session_id ? { sessionId: row.session_id as string } : {}),
        payload: prepared.payload,
        createdAt: row.created_at as number,
      };
      state.events.push(event);
      state.nextEventSeq = Math.max(state.nextEventSeq, event.seq + 1);
    }
    const sequence = this.database
      .prepare(
        "SELECT reserved_through FROM session_event_sequence WHERE id = 1",
      )
      .get() as { reserved_through?: number } | undefined;
    this.reservedEventSeq = sequence?.reserved_through ?? 0;
    state.nextEventSeq = Math.max(
      state.nextEventSeq,
      this.reservedEventSeq + 1,
    );
    return state;
  }

  private allocateEventSequence(): number {
    if (this.state.nextEventSeq > this.reservedEventSeq) {
      const reservedThrough =
        this.state.nextEventSeq + EVENT_SEQUENCE_BLOCK_SIZE - 1;
      this.database
        .prepare(
          `
        INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET reserved_through = excluded.reserved_through
      `,
        )
        .run(reservedThrough);
      this.reservedEventSeq = reservedThrough;
    }
    return this.state.nextEventSeq++;
  }

  private save(): void {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    if (this.transactionDepth > 0) {
      this.saveRequested = true;
      return;
    }
    try {
      this.database.transaction(() => this.persistChanges())();
      this.clearDirtyDeltas();
      this.mutations = createMutationBuffer();
    } catch (error) {
      this.state = this.load();
      this.clearDirtyDeltas();
      this.mutations = createMutationBuffer();
      throw error;
    }
  }

  private assertCurrentOwner(): void {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
  }

  private throwOwnerFenceError(): never {
    const row = this.database
      .prepare("SELECT * FROM application_owner WHERE key = 'application'")
      .get() as Record<string, unknown> | undefined;
    if (row)
      throw new ApplicationOwnerConflictError(applicationOwnerFromRow(row));
    throw new Error("Application owner lease is no longer active");
  }

  private persistChanges(): void {
    if (this.dirtyDeltaPartIds.size > 0)
      this.persistDeltaPartRows([...this.dirtyDeltaPartIds]);

    const deleteInputAttachment = this.database.prepare(
      "DELETE FROM session_input_attachment WHERE id = ?",
    );
    for (const id of this.mutations.deletedInputAttachments) {
      deleteInputAttachment.run(id);
    }
    const deletePart = this.database.prepare(
      "DELETE FROM session_message_part WHERE id = ?",
    );
    for (const id of this.mutations.deletedParts) deletePart.run(id);
    const deleteMessage = this.database.prepare(
      "DELETE FROM session_message WHERE id = ?",
    );
    for (const id of this.mutations.deletedMessages) deleteMessage.run(id);
    const deleteAttempt = this.database.prepare(
      "DELETE FROM session_run_attempt WHERE id = ?",
    );
    for (const id of this.mutations.deletedAttempts) deleteAttempt.run(id);
    const deleteRun = this.database.prepare(
      "DELETE FROM session_run WHERE id = ?",
    );
    for (const id of this.mutations.deletedRuns) deleteRun.run(id);
    const deleteInput = this.database.prepare(
      "DELETE FROM session_input WHERE id = ?",
    );
    for (const id of this.mutations.deletedInputs) deleteInput.run(id);

    const upsertSession = this.database.prepare(`
      INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, cwd=excluded.cwd,
        project_id=excluded.project_id, cwd_relative=excluded.cwd_relative,
        title=excluded.title, model=excluded.model, agent=excluded.agent, status=excluded.status,
        metadata_json=excluded.metadata_json, created_at=excluded.created_at,
        updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `);
    for (const id of this.mutations.sessions) {
      const value = this.state.sessions[id];
      if (value)
        upsertSession.run(
          value.id,
          value.parentId ?? null,
          value.cwd,
          value.title,
          value.model,
          value.agent ?? null,
          value.status,
          encode(value.metadata),
          value.createdAt,
          value.updatedAt,
          value.archivedAt ?? null,
          value.projectId ?? null,
          value.cwdRelative ?? null,
        );
    }

    const upsertInput = this.database.prepare(`
      INSERT INTO session_input (
        id, session_id, seq, delivery, content, metadata_json, created_at,
        items_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
        delivery=excluded.delivery, content=excluded.content, metadata_json=excluded.metadata_json,
        created_at=excluded.created_at, items_json=excluded.items_json
    `);
    for (const id of this.mutations.inputs) {
      const value = this.state.inputs[id];
      if (value)
        upsertInput.run(
          value.id,
          value.sessionId,
          value.seq,
          value.delivery,
          value.content,
          encode(value.metadata),
          value.createdAt,
          encode(value.items),
        );
    }

    const upsertInputAttachment = this.database.prepare(`
      INSERT INTO session_input_attachment (
        id, session_id, input_id, asset_id, seq, intent, display_name,
        media_type, size_bytes, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
        input_id=excluded.input_id, asset_id=excluded.asset_id, seq=excluded.seq,
        intent=excluded.intent, display_name=excluded.display_name,
        media_type=excluded.media_type, size_bytes=excluded.size_bytes,
        metadata_json=excluded.metadata_json, created_at=excluded.created_at
    `);
    for (const id of this.mutations.inputAttachments) {
      const value = this.state.inputAttachments[id];
      if (value) {
        upsertInputAttachment.run(
          value.id,
          value.sessionId,
          value.inputId,
          value.assetId,
          value.seq,
          value.intent,
          value.displayName,
          value.mediaType,
          value.sizeBytes,
          encode(value.metadata),
          value.createdAt,
        );
      }
    }

    const upsertMessage = this.database.prepare(`
      INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
        role=excluded.role, run_id=excluded.run_id, input_id=excluded.input_id,
        metadata_json=excluded.metadata_json, created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.messages) {
      const value = this.state.messages[id];
      if (value)
        upsertMessage.run(
          value.id,
          value.sessionId,
          value.seq,
          value.role,
          value.runId ?? null,
          value.inputId ?? null,
          encode(value.metadata),
          value.createdAt,
          value.updatedAt,
        );
    }

    const upsertPart = this.database.prepare(`
      INSERT INTO session_message_part (
        id, session_id, message_id, seq, type, status, text, tool_use_id, tool_name,
        input_json, output_json, is_error, asset_id, attachment_intent, display_name,
        media_type, size_bytes, transformation_kind, representation_id, processor,
        transformation_error, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id,
        seq=excluded.seq, type=excluded.type, status=excluded.status, text=excluded.text,
        tool_use_id=excluded.tool_use_id, tool_name=excluded.tool_name, input_json=excluded.input_json,
        output_json=excluded.output_json, is_error=excluded.is_error, asset_id=excluded.asset_id,
        attachment_intent=excluded.attachment_intent, display_name=excluded.display_name,
        media_type=excluded.media_type, size_bytes=excluded.size_bytes,
        transformation_kind=excluded.transformation_kind, representation_id=excluded.representation_id,
        processor=excluded.processor, transformation_error=excluded.transformation_error,
        metadata_json=excluded.metadata_json,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.parts) {
      const value = this.state.parts[id];
      if (value)
        upsertPart.run(
          value.id,
          value.sessionId,
          value.messageId,
          value.seq,
          value.type,
          value.status,
          value.text ?? null,
          value.toolUseId ?? null,
          value.toolName ?? null,
          value.input === undefined ? null : encode(value.input),
          value.output === undefined ? null : JSON.stringify(value.output),
          value.isError === undefined ? null : Number(value.isError),
          value.assetId ?? null,
          value.intent ?? null,
          value.displayName ?? null,
          value.mediaType ?? null,
          value.sizeBytes ?? null,
          value.kind ?? null,
          value.representationId ?? null,
          value.processor ?? null,
          value.transformationError ?? null,
          encode(value.metadata),
          value.createdAt,
          value.updatedAt,
        );
    }

    const upsertRun = this.database.prepare(`
      INSERT INTO session_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, input_id=excluded.input_id,
        status=excluded.status, started_at=excluded.started_at, finished_at=excluded.finished_at,
        error=excluded.error, metadata_json=excluded.metadata_json, created_at=excluded.created_at,
        updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.runs) {
      const value = this.state.runs[id];
      if (value)
        upsertRun.run(
          value.id,
          value.sessionId,
          value.inputId ?? null,
          value.status,
          value.startedAt ?? null,
          value.finishedAt ?? null,
          value.error ?? null,
          encode(value.metadata),
          value.createdAt,
          value.updatedAt,
        );
    }

    const upsertAttempt = this.database.prepare(`
      INSERT INTO session_run_attempt VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, sequence=excluded.sequence,
        status=excluded.status, provider=excluded.provider, model=excluded.model,
        retry_reason=excluded.retry_reason, error_kind=excluded.error_kind, error=excluded.error,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        started_at=excluded.started_at, finished_at=excluded.finished_at,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.attempts) {
      const value = this.state.attempts[id];
      if (value)
        upsertAttempt.run(
          value.id,
          value.runId,
          value.sequence,
          value.status,
          value.provider ?? null,
          value.model ?? null,
          value.retryReason ?? null,
          value.errorKind ?? null,
          value.error ?? null,
          value.inputTokens ?? null,
          value.outputTokens ?? null,
          value.startedAt ?? null,
          value.finishedAt ?? null,
          value.createdAt,
          value.updatedAt,
        );
    }

    const upsertTask = this.database.prepare(`
      INSERT INTO session_task (
        id, session_id, request_namespace, request_id, child_session_id, run_id, type,
        status, description, cwd, output, error, metadata_json, created_at, started_at,
        finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
        request_namespace=excluded.request_namespace, request_id=excluded.request_id,
        child_session_id=excluded.child_session_id, run_id=excluded.run_id, type=excluded.type,
        status=excluded.status, description=excluded.description, cwd=excluded.cwd,
        output=excluded.output, error=excluded.error, metadata_json=excluded.metadata_json,
        created_at=excluded.created_at, started_at=excluded.started_at,
        finished_at=excluded.finished_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.tasks) {
      const value = this.state.tasks[id];
      if (value)
        upsertTask.run(
          value.id,
          value.sessionId,
          value.requestNamespace ?? null,
          value.requestId ?? null,
          value.childSessionId ?? null,
          value.runId ?? null,
          value.type,
          value.status,
          value.description,
          value.cwd,
          value.output ?? null,
          value.error ?? null,
          encode(value.metadata),
          value.createdAt,
          value.startedAt ?? null,
          value.finishedAt ?? null,
          value.updatedAt,
        );
    }

    const upsertPermission = this.database.prepare(`
      INSERT INTO permission_request VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, run_id=excluded.run_id,
        tool_name=excluded.tool_name, payload_json=excluded.payload_json, status=excluded.status,
        decision=excluded.decision, decided_by_client_id=excluded.decided_by_client_id,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.permissions) {
      const value = this.state.permissions[id];
      if (value)
        upsertPermission.run(
          value.id,
          value.sessionId,
          value.runId ?? null,
          value.toolName,
          encode(value.payload),
          value.status,
          value.decision ?? null,
          value.decidedByClientId ?? null,
          value.createdAt,
          value.updatedAt,
        );
    }

    const insertEvent = this.database.prepare(`
      INSERT INTO session_event
        (id, seq, type, session_id, payload_json, created_at, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const value of this.state.events) {
      if (!this.mutations.events.has(value.id) || !isDurableEvent(value))
        continue;
      insertEvent.run(
        value.id,
        value.seq,
        value.type,
        value.sessionId ?? null,
        encode(value.payload),
        value.createdAt,
        value.schemaVersion,
      );
    }
  }

  private persistDeltaPartRows(partIds: string[]): void {
    const updatePart = this.database.prepare(
      "UPDATE session_message_part SET text = ?, updated_at = ? WHERE id = ?",
    );
    const updateMessage = this.database.prepare(
      "UPDATE session_message SET updated_at = ? WHERE id = ?",
    );
    const updateSession = this.database.prepare(
      "UPDATE session SET updated_at = ? WHERE id = ?",
    );
    const messageIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const partId of partIds) {
      const part = this.state.parts[partId];
      if (!part) continue;
      updatePart.run(part.text ?? "", part.updatedAt, part.id);
      messageIds.add(part.messageId);
      sessionIds.add(part.sessionId);
    }
    for (const messageId of messageIds) {
      const message = this.state.messages[messageId];
      if (message) updateMessage.run(message.updatedAt, message.id);
    }
    for (const sessionId of sessionIds) {
      const session = this.state.sessions[sessionId];
      if (session) updateSession.run(session.updatedAt, session.id);
    }
  }
}

function normalizeInputItems(
  input: StoreAdmitPromptInput,
): SessionUserInputItem[] {
  if (input.items !== undefined)
    return normalizeSessionUserInputItems(input.items);
  return normalizeSessionUserInputItems(
    input.content === undefined ? [] : [{ type: "text", text: input.content }],
  );
}

function hydrateInput(
  row: Record<string, unknown>,
): Pick<SessionInputRecord, "items" | "content"> {
  if (row.items_json === null || row.items_json === undefined) {
    throw new LegacySessionInputError();
  }
  if (typeof row.items_json !== "string") {
    throw new Error("invalid_session_input_items");
  }
  const items = normalizeSessionUserInputItems(
    decode(row.items_json) as unknown as SessionUserInputItem[],
  );
  return { items, content: sessionUserInputText(items) };
}

class LegacySessionInputError extends Error {
  readonly code = "legacy_session_input_unsupported";

  constructor() {
    super(
      "legacy_session_input_unsupported: clear legacy Session data before reopening it",
    );
  }
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function attachmentAssetFromRow(
  row: Record<string, unknown>,
): AttachmentAssetRecord {
  return parseAttachmentAssetRecord({
    id: row.id,
    displayName: row.display_name,
    ...(typeof row.declared_media_type === "string"
      ? { declaredMediaType: row.declared_media_type }
      : {}),
    ...(typeof row.media_type === "string"
      ? { mediaType: row.media_type }
      : {}),
    ...(typeof row.size_bytes === "number"
      ? { sizeBytes: row.size_bytes }
      : {}),
    ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    status: row.status,
    ...(typeof row.failure_code === "string"
      ? { failureCode: row.failure_code }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.deleted_at === "number"
      ? { deletedAt: row.deleted_at }
      : {}),
  });
}

function attachmentRepresentationFromRow(
  row: Record<string, unknown>,
): AttachmentRepresentationRecord {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    kind: String(row.kind) as AttachmentRepresentationRecord["kind"],
    status: String(row.status) as AttachmentRepresentationRecord["status"],
    processor: String(row.processor),
    processorVersion: String(row.processor_version),
    cacheKey: String(row.cache_key),
    mediaType: String(row.media_type),
    ...(row.text !== null && row.text !== undefined
      ? { text: String(row.text) }
      : {}),
    ...(row.error !== null && row.error !== undefined
      ? { error: String(row.error) }
      : {}),
    metadata: decode(String(row.metadata_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function attachmentLeaseFromRow(
  row: Record<string, unknown>,
): AttachmentLeaseRecord {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    ownerKind: String(row.owner_kind) as AttachmentLeaseRecord["ownerKind"],
    ownerId: String(row.owner_id),
    createdAt: Number(row.created_at),
    renewedAt: Number(row.renewed_at),
    expiresAt: Number(row.expires_at),
  };
}

function validateLeaseWindow(timestamp: number, expiresAt: number): void {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= timestamp
  ) {
    throw new Error("Attachment lease expiry must be after its timestamp");
  }
}

function externalConversationFromRow(
  row: Record<string, unknown>,
): ExternalConversationRecord {
  return {
    id: row.id as string,
    connector: row.connector as string,
    accountId: row.account_id as string,
    ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}),
    chatId: row.chat_id as string,
    ...(row.thread_id ? { threadId: row.thread_id as string } : {}),
    sessionId: row.session_id as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function channelDeliveryFromRow(
  row: Record<string, unknown>,
): ChannelDeliveryRecord {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    connector: row.connector as string,
    accountId: row.account_id as string,
    chatId: row.chat_id as string,
    ...(row.thread_id ? { threadId: row.thread_id as string } : {}),
    sessionId: row.session_id as string,
    inputId: row.input_id as string,
    runId: row.run_id as string,
    externalMessageId: row.external_message_id as string,
    content: row.content as string,
    status: row.status as ChannelDeliveryStatus,
    attemptCount: row.attempt_count as number,
    ...(row.external_delivery_id
      ? { externalDeliveryId: row.external_delivery_id as string }
      : {}),
    ...(row.error ? { error: row.error as string } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ...(row.sent_at ? { sentAt: row.sent_at as number } : {}),
  };
}

function storedWorkflowRunFromRow(
  row: Record<string, unknown>,
): StoredWorkflowRunRecord {
  return {
    runId: String(row.run_id),
    ...(typeof row.owner_session_id === "string"
      ? { ownerSessionId: row.owner_session_id }
      : {}),
    ...(typeof row.owner_input_id === "string"
      ? { ownerInputId: row.owner_input_id }
      : {}),
    ...(typeof row.owner_run_id === "string"
      ? { ownerRunId: row.owner_run_id }
      : {}),
    status: String(row.status),
    ...(typeof row.termination === "string"
      ? { termination: row.termination }
      : {}),
    snapshotJson: String(row.snapshot_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function applicationOwnerFromRow(
  row: Record<string, unknown>,
): ApplicationOwnerLease {
  return {
    ownerId: String(row.owner_id),
    pid: Number(row.pid),
    generation: Number(row.generation),
    startedAt: Number(row.started_at),
    heartbeatAt: Number(row.heartbeat_at),
  };
}

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at as number } : {}),
    ...(row.default_shell ? { defaultShell: row.default_shell as string } : {}),
    lastOpenedAt: row.last_opened_at as number,
    ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function isTerminalAttemptStatus(
  status: SessionRunAttemptRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function projectionSettlementFromRow(
  row: Record<string, unknown>,
): ProjectionSettlementRecord {
  return {
    id: row.id as string,
    projector: row.projector as string,
    rootSessionId: row.root_session_id as string,
    eventSequence: row.event_sequence as number,
    action: row.action as ProjectionSettlementRecord["action"],
    payload: decode(row.payload_json as string),
    status: row.status as ProjectionSettlementRecord["status"],
    attemptCount: row.attempt_count as number,
    ...(row.last_error ? { lastError: row.last_error as string } : {}),
    ...(row.next_retry_at !== null && row.next_retry_at !== undefined
      ? { nextRetryAt: row.next_retry_at as number }
      : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ...(row.resolved_at !== null && row.resolved_at !== undefined
      ? { resolvedAt: row.resolved_at as number }
      : {}),
  };
}

function normalizeProjectPath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function metadataWithoutTrace(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { traceId: _traceId, ...stable } = metadata;
  return stable;
}
