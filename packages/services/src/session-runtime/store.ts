import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
} from "@openharness/protocol";
import { AttachmentError } from "../attachment/attachment-errors.js";
import { SessionDatabase } from "../database/session-database.js";
import { DurableEventSequence } from "../database/event-sequence.js";
import { DeltaCheckpoint } from "../database/delta-checkpoint.js";
import {
  cloneMutationBuffer,
  createMutationBuffer,
  type MutationBuffer,
} from "../database/mutation-buffer.js";
import { loadSessionReadModel } from "../database/read-model.js";
import type { StorageContext } from "../database/storage-context.js";
import { ProjectRepository } from "../projects/project-repository.js";
import { ScheduleRepository } from "../schedules/schedule-repository.js";
import { WorkflowRepository } from "../workflows/workflow-repository.js";
import { ChannelRepository } from "../channels/channel-repository.js";
import { PermissionRepository } from "../permissions/permission-repository.js";
import {
  GoalRepository,
  GoalTransactions,
  type CreateSessionGoalStoreInput,
  type SessionGoalRequestRecord,
  type UpdateSessionGoalStoreInput,
} from "../goals/index.js";
import type {
  StoredWorkflowRunInput,
  StoredWorkflowRunRecord,
} from "../workflows/workflow-records.js";
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
  type SessionStoreOptions,
  type SessionState,
} from "./store-state.js";
import {
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  uniqueReferencedBytes,
} from "./prompt-attachments.js";

export type { SessionStoreOptions } from "./store-state.js";

export type {
  StoredWorkflowRunInput,
  StoredWorkflowRunRecord,
} from "../workflows/workflow-records.js";

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

export type {
  CreateSessionGoalStoreInput,
  SessionGoalRequestRecord,
  UpdateSessionGoalStoreInput,
} from "../goals/index.js";

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
  readonly projects!: ProjectRepository;
  readonly schedules!: ScheduleRepository;
  readonly workflows!: WorkflowRepository;
  readonly channels!: ChannelRepository;
  readonly permissions!: PermissionRepository;
  readonly goals!: GoalTransactions;
  private storage!: StorageContext;
  private closed = false;
  private transactionDepth = 0;
  private saveRequested = false;
  private readonly eventRegistry: DurableEventRegistry;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly taskListeners = new Map<string, Set<() => void>>();
  private activeOwnerLease?: ApplicationOwnerLease;

  constructor(options: SessionStoreOptions) {
    const database = SessionDatabase.open({ path: options.path });
    this.path = database.path;
    const deltaFlushIntervalMs = Math.max(
      1,
      options.deltaFlushIntervalMs ?? DEFAULT_DELTA_FLUSH_INTERVAL_MS,
    );
    const deltaFlushBytes = Math.max(
      1,
      options.deltaFlushBytes ?? DEFAULT_DELTA_FLUSH_BYTES,
    );
    const deltaCheckpoint = new DeltaCheckpoint({
      intervalMs: deltaFlushIntervalMs,
      bytes: deltaFlushBytes,
      flush: () => this.flushMessagePartDeltas(),
    });
    this.eventRegistry = options.eventRegistry ?? defaultDurableEventRegistry;
    this.attachmentLimits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.attachmentLimits,
    });
    try {
      const loaded = loadSessionReadModel(
        database.connection,
        this.eventRegistry,
      );
      this.storage = {
        database,
        state: loaded.state,
        mutations: createMutationBuffer(),
        eventSequence: DurableEventSequence.load(
          database.connection,
          loaded.state,
        ),
        deltaCheckpoint,
        atomic: (work) => this.transaction(work),
        assertWritable: () => this.assertCurrentOwner(),
      };
      this.projects = new ProjectRepository(this.storage);
      this.schedules = new ScheduleRepository(this.storage);
      this.workflows = new WorkflowRepository(this.storage);
      this.channels = new ChannelRepository(this.storage);
      this.permissions = new PermissionRepository({
        storage: this.storage,
        assertSession: (sessionId) => assertSession(this.state, sessionId),
        getRun: (runId) => this.getRun(runId),
        appendEvent: (input) => this.appendEvent(input),
      });
      const goalRepository = new GoalRepository(this.storage);
      this.goals = new GoalTransactions({
        storage: this.storage,
        repository: goalRepository,
        assertSession: (sessionId) => assertSession(this.state, sessionId),
        assertMutableSession,
        getRun: (runId) => this.getRun(runId),
        appendEvent: (input) => this.appendEvent(input),
      });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flushMessagePartDeltas();
    } finally {
      this.deltaCheckpoint.close();
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
    return this.projects.list(options);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    return this.projects.get(projectId);
  }

  inspectProject(inputPath: string): ProjectRecord {
    return this.projects.inspect(inputPath);
  }

  renameProject(projectId: string, name: string): ProjectRecord {
    return this.projects.rename(projectId, name);
  }

  setProjectPinned(projectId: string, pinned: boolean): ProjectRecord {
    return this.projects.setPinned(projectId, pinned);
  }

  setProjectDefaultShell(
    projectId: string,
    shell: string | null,
  ): ProjectRecord {
    return this.projects.setDefaultShell(projectId, shell);
  }

  archiveProject(projectId: string): ProjectRecord {
    return this.projects.archive(projectId);
  }

  rebindProject(projectId: string, inputPath: string): ProjectRecord {
    return this.projects.rebind(projectId, inputPath);
  }

  createScheduledTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    return this.schedules.createTask(input);
  }

  getScheduledTask(id: string): ScheduledTaskRecord | undefined {
    return this.schedules.getTask(id);
  }

  listScheduledTasks(
    options: { status?: ScheduledTaskRecord["status"] } = {},
  ): ScheduledTaskRecord[] {
    return this.schedules.listTasks(options);
  }

  updateScheduledTask(
    id: string,
    patch: UpdateScheduledTaskInput,
  ): ScheduledTaskRecord {
    return this.schedules.updateTask(id, patch);
  }

  deleteScheduledTask(id: string): boolean {
    return this.schedules.deleteTask(id);
  }

  createScheduledRun(input: CreateScheduledRunInput): ScheduledRunRecord {
    return this.schedules.createRun(input);
  }

  getScheduledRun(id: string): ScheduledRunRecord | undefined {
    return this.schedules.getRun(id);
  }

  listScheduledRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    return this.schedules.listRuns(options);
  }

  updateScheduledRun(
    id: string,
    patch: UpdateScheduledRunInput,
  ): ScheduledRunRecord {
    return this.schedules.updateRun(id, patch);
  }

  interruptActiveScheduledRuns(reason: string): number {
    return this.schedules.interruptActiveRuns(reason);
  }

  /**
   * Groups synchronous store mutations into one durable commit. Both SQLite
   * rows and the in-memory read model return to their previous state on error.
   */
  transaction<T>(work: () => T): T {
    const previous = structuredClone(this.state);
    const previousDeltaCheckpoint = this.deltaCheckpoint.snapshot();
    const previousSaveRequested = this.saveRequested;
    const previousEventSequence = this.eventSequence.snapshot();
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
        this.deltaCheckpoint.clear();
        this.mutations = createMutationBuffer();
      }
      completed = true;
      return result;
    } catch (error) {
      this.state = previous;
      this.eventSequence = DurableEventSequence.load(this.database, this.state);
      this.deltaCheckpoint.restore(previousDeltaCheckpoint);
      this.saveRequested = previousSaveRequested;
      this.eventSequence.restore(previousEventSequence);
      this.mutations = previousMutations;
      throw error;
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.saveRequested = previousSaveRequested;
        if (this.deltaCheckpoint.dirtyPartIds().length > 0) {
          if (completed && this.deltaCheckpoint.reachedThreshold()) {
            this.flushMessagePartDeltas();
          } else this.deltaCheckpoint.schedule();
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
      ? this.projects.get(projectId)
      : this.projects.inspect(input.cwd);
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
        this.deltaCheckpoint.delete(id);
      }
    }
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
    this.workflows.saveRun(input);
  }

  loadWorkflowRun(runId: string): StoredWorkflowRunRecord | undefined {
    return this.workflows.loadRun(runId);
  }

  listWorkflowRuns(
    options: { ownerSessionId?: string; status?: string } = {},
  ): StoredWorkflowRunRecord[] {
    return this.workflows.listRuns(options);
  }

  appendWorkflowEvent(input: {
    runId: string;
    sessionId?: string;
    type: string;
    eventJson: string;
    createdAt: number;
  }): number {
    const seq = this.workflows.appendEvent(input);
    if (input.sessionId) {
      this.appendEvent({
        type: `workflow.${input.type}`,
        sessionId: input.sessionId,
        payload: {
          event: JSON.parse(input.eventJson) as Record<string, unknown>,
        },
      });
    }
    return seq;
  }

  listWorkflowEvents(runId: string): string[] {
    return this.workflows.listEvents(runId);
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
    return this.workflows.claimRun(runId, ownerId);
  }

  finishWorkflowRunClaim(runId: string, ownerId: string, status: string): void {
    this.workflows.finishClaim(runId, ownerId, status);
  }

  findExternalConversation(input: {
    connector: string;
    accountId: string;
    chatId: string;
    threadId?: string;
  }): ExternalConversationRecord | undefined {
    return this.channels.findConversation(input);
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
    return this.channels.upsertConversation(input);
  }

  listExternalConversations(
    options: { connector?: string; limit?: number } = {},
  ): ExternalConversationRecord[] {
    return this.channels.listConversations(options);
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
    return this.channels.createDelivery(input);
  }

  getChannelDelivery(id: string): ChannelDeliveryRecord | undefined {
    return this.channels.getDelivery(id);
  }

  findChannelDeliveryByInput(inputId: string): ChannelDeliveryRecord | undefined {
    return this.channels.findDeliveryByInput(inputId);
  }

  updateChannelDelivery(
    id: string,
    input: {
      status: Extract<ChannelDeliveryStatus, "sent" | "failed" | "unknown">;
      externalDeliveryId?: string;
      error?: string;
    },
  ): ChannelDeliveryRecord {
    return this.channels.updateDelivery(id, input);
  }

  listChannelDeliveries(
    options: {
      statuses?: ChannelDeliveryStatus[];
      connector?: string;
      limit?: number;
    } = {},
  ): ChannelDeliveryRecord[] {
    return this.channels.listDeliveries(options);
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
        this.deltaCheckpoint.delete(id);
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
        this.deltaCheckpoint.delete(id);
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
    const reachedFlushThreshold = this.deltaCheckpoint.markDirty(
      part.id,
      Buffer.byteLength(input.delta, "utf8"),
    );
    if (this.transactionDepth === 0) {
      if (reachedFlushThreshold) this.flushMessagePartDeltas();
      else this.deltaCheckpoint.schedule();
    }
    return clone(event);
  }

  flushMessagePartDeltas(): void {
    const partIds = this.deltaCheckpoint.dirtyPartIds();
    if (partIds.length === 0) return;
    const flush = () => this.persistDeltaPartRows(partIds);
    if (this.transactionDepth > 0) flush();
    else this.database.transaction(flush)();
    for (const partId of partIds) this.deltaCheckpoint.delete(partId);
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
      | Record<string, unknown>
      | undefined;
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
    return this.goals.createGoal(input);
  }

  getGoalRequest(requestId: string): SessionGoalRequestRecord | undefined {
    return this.goals.getGoalRequest(requestId);
  }

  beginGoalRequest(input: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
  }): SessionGoalRequestRecord {
    return this.goals.beginGoalRequest(input);
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
    return this.goals.settleGoalRequest(requestId, input);
  }

  recordGoalAssessment(input: {
    goalId: string;
    revision: number;
    runId: string;
    assessment: Record<string, unknown>;
  }): void {
    this.goals.recordGoalAssessment(input);
  }

  goalEvidenceSignatures(goalId: string): string[] {
    return this.goals.goalEvidenceSignatures(goalId);
  }

  recordGoalContinuation(input: {
    goalId: string;
    revision: number;
    previousRunId: string;
    inputId: string;
    runId: string;
  }): boolean {
    return this.goals.recordGoalContinuation(input);
  }

  pauseActiveGoalsOnStartup(): number {
    return this.goals.pauseActiveGoalsOnStartup();
  }

  markGoalContinuation(
    runId: string,
    status: "dispatched" | "cancelled",
  ): void {
    this.goals.markGoalContinuation(runId, status);
  }

  finishGoalRun(runId: string): void {
    this.goals.finishGoalRun(runId);
  }

  startGoalRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): boolean {
    return this.goals.startGoalRun(goalId, revision, runId, automatic);
  }

  getGoal(id: string): SessionGoal | undefined {
    return this.goals.getGoal(id);
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    return this.goals.getCurrentGoal(sessionId);
  }

  updateGoal(id: string, input: UpdateSessionGoalStoreInput): SessionGoal {
    return this.goals.updateGoal(id, input);
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
    return this.permissions.expirePending(reason);
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
    return this.permissions.create(input);
  }

  replyPermission(input: ReplyPermissionInput): PermissionRequestRecord {
    return this.permissions.reply(input);
  }

  getPermissionRequest(requestId: string): PermissionRequestRecord | undefined {
    return this.permissions.get(requestId);
  }

  listPermissionRequests(
    options: ListPermissionRequestsOptions = {},
  ): PermissionRequestRecord[] {
    return this.permissions.list(options);
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
      seq: this.eventSequence.allocate(),
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
    const loaded = loadSessionReadModel(this.database, this.eventRegistry);
    this.eventSequence = DurableEventSequence.load(this.database, loaded.state);
    return loaded.state;
  }

  private get databaseKernel(): SessionDatabase {
    return this.storage.database;
  }

  private get database(): Database.Database {
    return this.storage.database.connection;
  }

  private get state(): SessionState {
    return this.storage.state;
  }

  private set state(value: SessionState) {
    this.storage.state = value;
  }

  private get mutations(): MutationBuffer {
    return this.storage.mutations;
  }

  private set mutations(value: MutationBuffer) {
    this.storage.mutations = value;
  }

  private get eventSequence(): DurableEventSequence {
    return this.storage.eventSequence;
  }

  private set eventSequence(value: DurableEventSequence) {
    this.storage.eventSequence = value;
  }

  private get deltaCheckpoint(): DeltaCheckpoint {
    return this.storage.deltaCheckpoint;
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
      this.deltaCheckpoint.clear();
      this.mutations = createMutationBuffer();
    } catch (error) {
      this.state = this.load();
      this.deltaCheckpoint.clear();
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
    const dirtyPartIds = this.deltaCheckpoint.dirtyPartIds();
    if (dirtyPartIds.length > 0) this.persistDeltaPartRows(dirtyPartIds);

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

function metadataWithoutTrace(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { traceId: _traceId, ...stable } = metadata;
  return stable;
}
