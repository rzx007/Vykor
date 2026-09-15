import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeSessionUserInputItems,
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
import {
  AttachmentRepository,
  AttachmentTransactions,
  type CreateAttachmentRepresentationInput,
  type AttachmentLeaseRecord,
  type AcquireAttachmentLeasesInput,
  type CreateImportingAttachmentInput,
  type MarkAttachmentReadyInput,
  type ImportingAttachmentRecord,
} from "../attachments/index.js";
export type {
  CreateAttachmentRepresentationInput,
  AttachmentLeaseRecord,
  AcquireAttachmentLeasesInput,
  CreateImportingAttachmentInput,
  MarkAttachmentReadyInput,
  ImportingAttachmentRecord,
} from "../attachments/index.js";
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
import {
  TransactionCoordinator,
  type TransactionCoordinatorHooks,
} from "../database/index.js";
import { ProjectRepository } from "../projects/project-repository.js";
import { ScheduleRepository } from "../schedules/schedule-repository.js";
import { WorkflowRepository } from "../workflows/workflow-repository.js";
import { ChannelRepository } from "../channels/channel-repository.js";
import { PermissionRepository } from "../permissions/permission-repository.js";
import { GoalRepository } from "../goals/goal-repository.js";
import { GoalTransactions } from "../goals/goal-transactions.js";
import { SessionRepository } from "../sessions/session-repository.js";
import {
  ConversationRepository,
  ConversationTransactions,
} from "../conversations/index.js";
import { RunRepository } from "../runs/run-repository.js";
import {
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

type StoreAdmitPromptInput = Omit<AdmitPromptInput, "content" | "items"> & {
  content?: string;
  items?: readonly SessionUserInputItem[];
};

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

export type {
  CreateSessionGoalStoreInput,
  SessionGoalRequestRecord,
  UpdateSessionGoalStoreInput,
} from "../goals/index.js";

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
  readonly attachments!: AttachmentTransactions;
  readonly sessions!: SessionRepository;
  readonly conversations!: ConversationRepository;
  readonly runs!: RunRepository;
  readonly conversationTransactions!: ConversationTransactions;
  private storage!: StorageContext;
  private closed = false;
  private _coordinator!: TransactionCoordinator;
  private readonly eventRegistry: DurableEventRegistry;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly taskListeners = new Map<string, Set<() => void>>();
  private activeOwnerLease?: ApplicationOwnerLease;

  private get coordinator(): TransactionCoordinator {
    return this.storage?.coordinator ?? this._coordinator;
  }

  private set coordinator(value: TransactionCoordinator) {
    this._coordinator = value;
    if (this.storage) {
      this.storage.coordinator = value;
    }
  }

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
        atomic: (work) => this.coordinator.atomic(work),
        deferUntilCommit: (callback) => this.coordinator.deferUntilCommit(callback),
        assertWritable: () => this.assertCurrentOwner(),
      };
      this.coordinator = new TransactionCoordinator({
        storage: this.storage,
        persistChanges: () => this.persistChanges(),
        flushDeltas: () => this.flushMessagePartDeltas(),
        hooks: options.transactionHooks,
      });
      this.projects = new ProjectRepository(this.storage);
      this.schedules = new ScheduleRepository(this.storage);
      this.workflows = new WorkflowRepository(this.storage);
      this.channels = new ChannelRepository(this.storage);
      this.conversations = new ConversationRepository({
        storage: this.storage,
        eventRegistry: this.eventRegistry,
        save: () => this.save(),
      });
      this.sessions = new SessionRepository({
        storage: this.storage,
        projects: this.projects,
        appendEvent: (input) => this.appendEvent(input),
        save: () => this.save(),
      });
      this.runs = new RunRepository({
        storage: this.storage,
        appendEvent: (input) => this.appendEvent(input),
        save: () => this.save(),
      });
      this.permissions = new PermissionRepository({
        storage: this.storage,
        assertSession: (sessionId) => assertSession(this.state, sessionId),
        getRun: (runId) => this.getRun(runId),
        appendEvent: (input) => this.appendEvent(input),
      });
      this.attachments = new AttachmentTransactions({
        storage: this.storage,
        repository: new AttachmentRepository(this.storage),
        countAttachmentReferences: (assetId) =>
          this.countAttachmentReferences(assetId),
        countInputAttachmentReferences: (assetId) =>
          this.countInputAttachmentReferences(assetId),
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
      this.conversationTransactions = new ConversationTransactions({
        storage: this.storage,
        conversations: this.conversations,
        sessions: this.sessions,
        runs: this.runs,
        attachments: this.attachments,
        attachmentLimits: this.attachmentLimits,
        save: () => this.save(),
        notifySessionTask: (taskId) => this.notifySessionTask(taskId),
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
    return this.attachments.createImportingAttachment(input);
  }

  markAttachmentReady(
    id: string,
    input: MarkAttachmentReadyInput,
  ): AttachmentAssetRecord {
    return this.attachments.markAttachmentReady(id, input);
  }

  failAttachmentImport(
    id: string,
    failureCode: string,
    updatedAt = now(),
  ): AttachmentAssetRecord {
    return this.attachments.failAttachmentImport(id, failureCode, updatedAt);
  }

  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    return this.attachments.getAttachment(id, options);
  }

  findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined {
    return this.attachments.findReadyAttachmentByHash(sha256);
  }

  listAttachments(
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord[] {
    return this.attachments.listAttachments(options);
  }

  listImportingAttachments(): ImportingAttachmentRecord[] {
    return this.attachments.listImportingAttachments();
  }

  createAttachmentRepresentation(
    input: CreateAttachmentRepresentationInput,
  ): AttachmentRepresentationRecord {
    return this.attachments.createAttachmentRepresentation(input);
  }

  getAttachmentRepresentation(
    id: string,
  ): AttachmentRepresentationRecord | undefined {
    return this.attachments.getAttachmentRepresentation(id);
  }

  listAttachmentRepresentations(
    assetId: string,
  ): AttachmentRepresentationRecord[] {
    return this.attachments.listAttachmentRepresentations(assetId);
  }

  acquireAttachmentLeases(
    input: AcquireAttachmentLeasesInput,
  ): AttachmentLeaseRecord[] {
    return this.attachments.acquireAttachmentLeases(input);
  }

  renewAttachmentLeases(input: {
    ownerKind: AttachmentLeaseRecord["ownerKind"];
    ownerId: string;
    timestamp: number;
    expiresAt: number;
  }): number {
    return this.attachments.renewAttachmentLeases(input);
  }

  releaseAttachmentLeases(
    ownerKind: AttachmentLeaseRecord["ownerKind"],
    ownerId: string,
  ): number {
    return this.attachments.releaseAttachmentLeases(ownerKind, ownerId);
  }

  listActiveAttachmentLeases(timestamp = now()): AttachmentLeaseRecord[] {
    return this.attachments.listActiveAttachmentLeases(timestamp);
  }

  listAttachmentLeases(): AttachmentLeaseRecord[] {
    return this.attachments.listAttachmentLeases();
  }

  deleteExpiredAttachmentLeases(timestamp = now()): number {
    return this.attachments.deleteExpiredAttachmentLeases(timestamp);
  }

  purgeDeletedAttachment(
    assetId: string,
    timestamp = now(),
  ): AttachmentAssetRecord | undefined {
    return this.attachments.purgeDeletedAttachment(assetId, timestamp);
  }

  findCompletedAttachmentRepresentation(
    assetId: string,
    kind: AttachmentRepresentationKind,
    cacheKey: string,
  ): AttachmentRepresentationRecord | undefined {
    return this.attachments.findCompletedAttachmentRepresentation(assetId, kind, cacheKey);
  }

  completeAttachmentRepresentation(
    id: string,
    input: {
      text: string;
      metadata: Record<string, unknown>;
      updatedAt?: number;
    },
  ): AttachmentRepresentationRecord {
    return this.attachments.completeAttachmentRepresentation(id, input);
  }

  failAttachmentRepresentation(
    id: string,
    error: string,
    updatedAt = now(),
  ): AttachmentRepresentationRecord {
    return this.attachments.failAttachmentRepresentation(id, error, updatedAt);
  }

  softDeleteAttachment(id: string, deletedAt = now()): AttachmentAssetRecord {
    return this.attachments.softDeleteAttachment(id, deletedAt);
  }

  softDeleteUnreferencedAttachment(
    id: string,
    deletedAt = now(),
  ): AttachmentAssetRecord {
    return this.attachments.softDeleteUnreferencedAttachment(id, deletedAt);
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
    return this.coordinator.atomic(work);
  }

  createSession(input: CreateSessionInput): SessionRecord {
    return this.sessions.create(input);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(options: ListSessionsOptions = {}): SessionRecord[] {
    return this.sessions.list(options);
  }

  listChildSessions(
    parentId: string,
    options: { includeArchived?: boolean } = {},
  ): SessionRecord[] {
    return this.sessions.listChildren(parentId, options);
  }

  deleteSessionTree(sessionId: string): string[] {
    return this.conversationTransactions.deleteSessionTree(sessionId);
  }

  archiveSession(sessionId: string): SessionRecord {
    return this.sessions.archive(sessionId);
  }

  /** Prevent further mutation while the server joins interrupted work. */
  beginArchive(sessionId: string): SessionRecord {
    return this.sessions.beginArchive(sessionId);
  }

  updateSession(sessionId: string, input: UpdateSessionInput): SessionRecord {
    return this.sessions.update(sessionId, input);
  }

  admitPrompt(
    input: StoreAdmitPromptInput,
    options: { attachmentLimits?: Partial<AttachmentLimits> } = {},
  ): SessionInputRecord {
    return this.conversationTransactions.admitPrompt(input, options);
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
    return this.conversationTransactions.admitPromptWithRun(input, options);
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
    return this.conversationTransactions.replaceTranscriptAndAdmitPrompt(input);
  }

  createReplayRun(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown> } = {},
  ): SessionRunRecord {
    return this.conversationTransactions.createReplayRun(inputId, input);
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
    return this.conversationTransactions.replaceLatestPromptWithAdmission(input);
  }

  forkSessionWithHistory(input: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    session: CreateSessionInput;
  }): SessionRecord {
    return this.conversationTransactions.forkSessionWithHistory(input);
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
    return this.conversations.getInput(inputId);
  }

  listInputAttachments(inputId: string): SessionInputAttachmentRecord[] {
    return this.conversations.listInputAttachments(inputId);
  }

  listSessionInputAttachments(
    sessionId: string,
  ): SessionInputAttachmentRecord[] {
    return this.conversations.listSessionInputAttachments(sessionId);
  }

  countInputAttachmentReferences(assetId: string): number {
    return this.conversations.countInputAttachmentReferences(assetId);
  }

  countAttachmentReferences(assetId: string): number {
    return this.conversations.countAttachmentReferences(assetId);
  }

  listInputs(sessionId: string): SessionInputRecord[] {
    return this.conversations.listInputs(sessionId);
  }

  createMessage(input: CreateMessageInput): SessionMessageRecord {
    return this.conversations.createMessage(input);
  }

  listMessages(
    sessionId: string,
    options: ListMessagesOptions = {},
  ): SessionMessageRecord[] {
    return this.conversations.listMessages(sessionId, options);
  }

  /**
   * Replace a session transcript atomically (used by /compact).
   * Emits a single `session.transcript.replaced` event with the new messages/parts.
   */
  replaceTranscript(input: ReplaceTranscriptInput): {
    messages: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  } {
    return this.conversationTransactions.replaceTranscript(input);
  }

  upsertMessagePart(input: UpsertMessagePartInput): SessionMessagePartRecord {
    return this.conversations.upsertMessagePart(input);
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
    if (!this.coordinator.inTransaction) {
      if (reachedFlushThreshold) this.flushMessagePartDeltas();
      else this.deltaCheckpoint.schedule();
    }
    return clone(event);
  }

  flushMessagePartDeltas(): void {
    const partIds = this.deltaCheckpoint.dirtyPartIds();
    if (partIds.length === 0) return;
    const flush = () => this.persistDeltaPartRows(partIds);
    if (this.coordinator.inTransaction) flush();
    else this.database.transaction(flush)();
    for (const partId of partIds) this.deltaCheckpoint.delete(partId);
  }

  listMessageParts(
    sessionId: string,
    options: ListMessagePartsOptions = {},
  ): SessionMessagePartRecord[] {
    return this.conversations.listMessageParts(sessionId, options);
  }

  appendEvent(input: AppendEventInput): SessionEventRecord {
    return this.conversations.appendEvent(input);
  }

  listEvents(options: ListEventsOptions = {}): SessionEventRecord[] {
    return this.conversations.listEvents(options);
  }

  latestEventSeq(): number {
    return this.conversations.latestEventSeq();
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
    return this.runs.createRun(input);
  }

  updateRun(runId: string, input: UpdateRunInput): SessionRunRecord {
    return this.runs.updateRun(runId, input);
  }

  getRun(runId: string): SessionRunRecord | undefined {
    return this.runs.getRun(runId);
  }

  findRunByInput(inputId: string): SessionRunRecord | undefined {
    return this.runs.findRunByInput(inputId);
  }

  listRunsByInput(inputId: string): SessionRunRecord[] {
    return this.runs.listRunsByInput(inputId);
  }

  findOwningRunByInput(inputId: string): SessionRunRecord | undefined {
    return this.runs.findOwningRunByInput(inputId);
  }

  listRuns(sessionId: string): SessionRunRecord[] {
    return this.runs.listRuns(sessionId);
  }

  createSessionTask(input: CreateSessionTaskInput): SessionExecutionRecord {
    const task = this.runs.createSessionTask(input);
    this.deferSessionTaskNotification(task.id);
    return task;
  }

  /** Atomically reserves one durable task for a producer request. */
  reserveSessionTask(
    input: CreateSessionTaskInput & {
      requestNamespace: string;
      requestId: string;
    },
  ): { task: SessionExecutionRecord; created: boolean } {
    const result = this.runs.reserveSessionTask(input);
    if (result.created) {
      this.deferSessionTaskNotification(result.task.id);
    }
    return result;
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
    const result = this.runs.transitionPendingSessionTask(taskId, input);
    if (result.transitioned) {
      this.deferSessionTaskNotification(taskId);
    }
    return result;
  }

  updateSessionTask(
    taskId: string,
    input: UpdateSessionTaskInput,
  ): SessionExecutionRecord {
    const task = this.runs.updateSessionTask(taskId, input);
    this.deferSessionTaskNotification(taskId);
    return task;
  }

  getSessionTask(taskId: string): SessionExecutionRecord | undefined {
    return this.runs.getSessionTask(taskId);
  }

  listSessionTasks(sessionId: string): SessionExecutionRecord[] {
    return this.runs.listSessionTasks(sessionId);
  }

  findSessionExecutionByRuntimeId(
    sessionId: string,
    runtimeExecutionId: string,
  ): SessionExecutionRecord | undefined {
    return this.runs.findSessionExecutionByRuntimeId(
      sessionId,
      runtimeExecutionId,
    );
  }

  /** A daemon restart cannot retain child Agent callbacks or detached process handles. */
  interruptActiveSessionTasks(
    reason = "Daemon restarted before the task completed",
  ): number {
    return this.conversationTransactions.interruptActiveSessionTasks(reason);
  }

  /**
   * Mark work owned by a previous daemon process as terminal. A fresh daemon
   * cannot resume an in-memory QueryEngine run, so leaving these rows active
   * would keep every attached client permanently busy.
   */
  interruptActiveRuns(
    reason = "Daemon restarted before the run completed",
  ): number {
    return this.conversationTransactions.interruptActiveRuns(reason);
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

  private deferSessionTaskNotification(taskId: string): void {
    this.storage.deferUntilCommit?.(() => this.notifySessionTask(taskId));
  }

  createRunAttempt(input: CreateRunAttemptInput): SessionRunAttemptRecord {
    return this.runs.createRunAttempt(input);
  }

  updateRunAttempt(
    attemptId: string,
    input: UpdateRunAttemptInput,
  ): SessionRunAttemptRecord {
    return this.runs.updateRunAttempt(attemptId, input);
  }

  getRunAttempt(attemptId: string): SessionRunAttemptRecord | undefined {
    return this.runs.getRunAttempt(attemptId);
  }

  listRunAttempts(runId: string): SessionRunAttemptRecord[] {
    return this.runs.listRunAttempts(runId);
  }

  settleActiveRunAttempts(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): number {
    return this.conversationTransactions.settleActiveRunAttempts(runId, status, error);
  }

  /**
   * A durable input without either a primary run or transcript ownership may
   * have been left between admission and live delivery by a previous daemon.
   * Give it a terminal owner without replaying the model or any tool effect.
   */
  terminalizeUnownedInputs(
    reason = "Daemon restarted before the input was assigned to a run",
  ): number {
    return this.conversationTransactions.terminalizeUnownedInputs(reason);
  }

  /** A previous process cannot retain the resolver behind a pending permission prompt. */
  expirePendingPermissionRequests(
    reason = "Daemon restarted before the permission was resolved",
  ): number {
    return this.permissions.expirePending(reason);
  }

  /** Complete an archive that was interrupted by a daemon process exit. */
  finalizeClosingSessions(): number {
    return this.conversationTransactions.finalizeClosingSessions();
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
    return this.conversations.appendEventInMemory(input, retain);
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
    if (this.coordinator.inTransaction) {
      this.coordinator.requestSave();
      return;
    }
    try {
      this.coordinator.atomic(() => {
        this.coordinator.requestSave();
      });
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
