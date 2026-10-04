import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { applicationOwners } from "./schema.js";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeSessionUserInputItems,
  parseAttachmentLimits,
  sessionUserInputText,
} from "@vykor/protocol";

import type {
  AdmitPromptInput,
  AdmitPromptWithRunInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateProjectionSettlementInput,
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
  UpdateRunInput,
  UpdateRunAttemptInput,
  UpdateSessionTaskInput,
  UpdateSessionInput,
  ReplaceTranscriptInput,
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
  AttachmentLimits,
  SessionInputAttachmentRecord,
  SessionUserInputItem,
  SessionGoal,
} from "@vykor/protocol";
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
import { AttachmentError } from "../attachments/attachment-errors.js";
import { SessionDatabase } from "../database/session-database.js";
import { DurableEventSequence } from "../database/event-sequence.js";
import { DeltaCheckpoint } from "../database/delta-checkpoint.js";
import {
  cloneMutationBuffer,
  createMutationBuffer,
  type MutationBuffer,
} from "../database/mutation-buffer.js";
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
  IncrementalOutput,
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
  emptyState,
  isTerminalRunStatus,
  maxSeq,
  type SessionStoreOptions,
  type SessionState,
} from "./store-state.js";
import { persistSessionChanges } from "./store-persistence.js";
import { assertSynchronousCommit, ChatPersistenceRouter } from "../database/chat-persistence.js";
import { TemporaryControlRecords } from "../database/temporary-control-records.js";
import { SqliteChatPersistence } from "../database/sqlite-chat-persistence.js";
import {
  abandonProjectionSettlement,
  createProjectionSettlement,
  failProjectionSettlement,
  getProjectionSettlement,
  listProjectionSettlements,
  markProjectionSettlementRetrying,
  resolveProjectionSettlement,
} from "./projection-settlements.js";
import {
  DEFAULT_RETENTION_POLICY,
  applyRetention,
  latestRetentionAudit,
  listRetentionAudits,
  recordRetentionAudit,
  type RetentionPolicy,
} from "./session-retention.js";

export { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from "./session-retention.js";
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
  readonly incrementalOutput!: IncrementalOutput;
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
      flush: () => this.incrementalOutput.flushMessagePartDeltas(),
    });
    this.eventRegistry = options.eventRegistry ?? defaultDurableEventRegistry;
    this.attachmentLimits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.attachmentLimits,
    });
    try {
      const loadedState = new SqliteChatPersistence(database).load(this.eventRegistry);
      this.storage = {
        database,
        state: loadedState,
        mutations: createMutationBuffer(),
        eventSequence: DurableEventSequence.load(
          database.orm,
          loadedState,
        ),
        deltaCheckpoint,
        atomic: (work) => this.coordinator.atomic(work),
        deferUntilCommit: (callback) => this.coordinator.deferUntilCommit(callback),
        assertWritable: () => this.assertCurrentOwner(),
      };
      this.coordinator = new TransactionCoordinator({
        storage: this.storage,
        persistChanges: () => this.persistChanges(),
        flushDeltas: () => this.incrementalOutput.flushMessagePartDeltas(),
        hooks: options.transactionHooks,
      });
      this.storage.chatPersistence = new ChatPersistenceRouter(this.storage);
      this.storage.temporaryControls = new TemporaryControlRecords();
      this.projects = new ProjectRepository(this.storage);
      this.schedules = new ScheduleRepository(this.storage, (input) => this.conversations.appendEvent(input));
      this.workflows = new WorkflowRepository(this.storage);
      this.channels = new ChannelRepository(this.storage);
      this.conversations = new ConversationRepository({
        storage: this.storage,
        eventRegistry: this.eventRegistry,
        save: () => this.save(),
        recordAttachmentSource: (assetId, sessionId) => this.recordChatAttachmentSource(assetId, sessionId),
      });
      this.incrementalOutput = new IncrementalOutput({
        storage: this.storage,
        appendTransientEvent: (input) => this.conversations.appendEventInMemory(input, false),
      });
      this.sessions = new SessionRepository({
        storage: this.storage,
        projects: this.projects,
        appendEvent: (input) => this.conversations.appendEvent(input),
        save: () => this.save(),
      });
      this.runs = new RunRepository({
        storage: this.storage,
        appendEvent: (input) => this.conversations.appendEvent(input),
        save: () => this.save(),
      });
      this.permissions = new PermissionRepository({
        storage: this.storage,
        assertSession: (sessionId) => assertSession(this.state, sessionId),
        getRun: (runId) => this.runs.getRun(runId),
        appendEvent: (input) => this.conversations.appendEvent(input),
      });
      this.attachments = new AttachmentTransactions({
        storage: this.storage,
        repository: new AttachmentRepository(this.storage),
        countAttachmentReferences: (assetId) =>
          this.conversations.countAttachmentReferences(assetId),
        countInputAttachmentReferences: (assetId) =>
          this.conversations.countInputAttachmentReferences(assetId),
      });
      const goalRepository = new GoalRepository(this.storage);
      this.goals = new GoalTransactions({
        storage: this.storage,
        repository: goalRepository,
        assertSession: (sessionId) => assertSession(this.state, sessionId),
        assertMutableSession,
        getRun: (runId) => this.runs.getRun(runId),
        appendEvent: (input) => this.conversations.appendEvent(input),
      });
      this.conversationTransactions = new ConversationTransactions({
        storage: this.storage,
        conversations: this.conversations,
        sessions: this.sessions,
        runs: this.runs,
        permissions: this.permissions,
        attachments: this.attachments,
        attachmentLimits: this.attachmentLimits,
        save: () => this.save(),
        notifySessionTask: (taskId) => this.notifySessionTask(taskId),
        recordAttachmentSource: (assetId, sessionId) => this.recordChatAttachmentSource(assetId, sessionId),
      });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.incrementalOutput.close();
    } finally {
      this.databaseKernel.close();
      this.closed = true;
    }
  }

  /** Atomically commits a deliberately cross-domain storage operation. */
  transaction<T>(work: () => T): T {
    return this.coordinator.atomic(work);
  }

  async backupDatabase(destination: string): Promise<void> {
    if (this.activeOwnerLease)
      this.assertApplicationOwner(this.activeOwnerLease);
    this.incrementalOutput.flushMessagePartDeltas();
    mkdirSync(dirname(resolve(destination)), { recursive: true });
    const path = resolve(destination);
    await this.database.backup(path);
    const backup = new Database(path);
    try {
      // owner 是当前进程的活租约，不能带进恢复目录；Run/Workflow 保留给启动恢复收束。
      drizzle(backup).delete(applicationOwners).run();
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
      this.conversations.appendEvent({
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
      const row = this.orm.select().from(applicationOwners)
        .where(eq(applicationOwners.key, "application")).get();
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
      this.orm.insert(applicationOwners).values({ key: "application", ...next })
        .onConflictDoUpdate({ target: applicationOwners.key, set: next }).run();
      return next;
    })();
    this.activeOwnerLease = lease;
    return lease;
  }

  heartbeatApplicationOwner(
    lease: ApplicationOwnerLease,
    timestamp = Date.now(),
  ): ApplicationOwnerLease {
    const result = this.orm.update(applicationOwners).set({ heartbeatAt: timestamp })
      .where(and(
        eq(applicationOwners.key, "application"),
        eq(applicationOwners.ownerId, lease.ownerId),
        eq(applicationOwners.generation, lease.generation),
      )).run();
    if (result.changes !== 1) this.throwOwnerFenceError();
    const next = { ...lease, heartbeatAt: timestamp };
    this.activeOwnerLease = next;
    return next;
  }

  releaseApplicationOwner(lease: ApplicationOwnerLease): void {
    this.orm.delete(applicationOwners).where(and(
      eq(applicationOwners.key, "application"),
      eq(applicationOwners.ownerId, lease.ownerId),
      eq(applicationOwners.generation, lease.generation),
    )).run();
    if (
      this.activeOwnerLease?.ownerId === lease.ownerId &&
      this.activeOwnerLease.generation === lease.generation
    )
      this.activeOwnerLease = undefined;
  }

  assertApplicationOwner(lease: ApplicationOwnerLease): void {
    const row = this.orm.select().from(applicationOwners)
        .where(eq(applicationOwners.key, "application")).get();
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
    if (this.activeOwnerLease) this.assertApplicationOwner(this.activeOwnerLease);
    return applyRetention(this.orm, this.state, policy, timestamp,
      new Set(this.storage.chatPersistence?.snapshot().events.map((event) => event.id)));
  }

  listRetentionAudits(): Array<Record<string, unknown>> {
    return listRetentionAudits(this.orm);
  }

  recordRetentionAudit(input: {
    policy: string;
    result: unknown;
    timestamp?: number;
  }): void {
    recordRetentionAudit(this.orm, input);
  }

  latestRetentionAudit(policy: string):
    | {
        id: string;
        policy: string;
        result: unknown;
        createdAt: number;
      }
    | undefined {
    return latestRetentionAudit(this.orm, policy);
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

  /** Atomically persists a queued prompt and the one root run that owns it. */
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

  createProjectionSettlement(input: CreateProjectionSettlementInput): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    return createProjectionSettlement(this.orm, input, this.storage.temporaryControls, this.state.sessions[input.rootSessionId]?.storage ?? "sqlite");
  }

  getProjectionSettlement(id: string): ProjectionSettlementRecord | undefined {
    return getProjectionSettlement(this.orm, id, this.storage.temporaryControls);
  }

  listProjectionSettlements(options: ListProjectionSettlementsOptions = {}): ProjectionSettlementRecord[] {
    return listProjectionSettlements(this.orm, options, this.storage.temporaryControls);
  }

  markProjectionSettlementRetrying(id: string): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    return markProjectionSettlementRetrying(this.orm, id, this.storage.temporaryControls);
  }

  failProjectionSettlement(id: string, error: string, nextRetryAt?: number): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    return failProjectionSettlement(this.orm, id, error, nextRetryAt, this.storage.temporaryControls);
  }

  resolveProjectionSettlement(id: string): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    return resolveProjectionSettlement(this.orm, id, this.storage.temporaryControls);
  }

  abandonProjectionSettlement(id: string, error: string): ProjectionSettlementRecord {
    this.assertCurrentOwner();
    return abandonProjectionSettlement(this.orm, id, error, this.storage.temporaryControls);
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
    const state = new SqliteChatPersistence(this.databaseKernel).load(this.eventRegistry);
    this.eventSequence = DurableEventSequence.load(this.orm, state);
    return state;
  }

  private get databaseKernel(): SessionDatabase {
    return this.storage.database;
  }

  private get database(): Database.Database {
    return this.storage.database.connection;
  }

  private get orm(): SessionDatabase["orm"] {
    return this.storage.database.orm;
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
      this.storage.chatPersistence?.restoreTemporaryState(this.state);
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
    const row = this.orm.select().from(applicationOwners)
        .where(eq(applicationOwners.key, "application")).get();
    if (row)
      throw new ApplicationOwnerConflictError(applicationOwnerFromRow(row));
    throw new Error("Application owner lease is no longer active");
  }

  private persistChanges(): void {
    this.incrementalOutput.flushMessagePartDeltas();
    if (this.storage.chatPersistence) assertSynchronousCommit(this.storage.chatPersistence.commit());
    else persistSessionChanges(this.storage, this.incrementalOutput);
  }

  private recordChatAttachmentSource(assetId: string, sessionId: string): void {
    // Diagnostic/transformation parts may reference an asset not yet registered.
    if (this.attachments.getAttachment(assetId, { includeDeleted: true })) {
      this.attachments.recordChatSource(assetId, assertSession(this.state, sessionId));
    }
  }
}

function applicationOwnerFromRow(
  row: typeof applicationOwners.$inferSelect,
): ApplicationOwnerLease {
  return {
    ownerId: String(row.ownerId),
    pid: Number(row.pid),
    generation: Number(row.generation),
    startedAt: Number(row.startedAt),
    heartbeatAt: Number(row.heartbeatAt),
  };
}

function isTerminalAttemptStatus(
  status: SessionRunAttemptRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
