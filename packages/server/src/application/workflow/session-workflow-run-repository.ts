import { randomUUID } from "node:crypto";

import {
  createWorkflowRunSummary,
  decodeWorkflowRunEvent,
  decodeWorkflowRunSnapshot,
  type WorkflowRunEvent,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunSummary,
} from "@vykor/coordinator";
import type {
  StoredWorkflowRunInput,
  StoredWorkflowRunRecord,
} from "@vykor/services/workflows";

export interface WorkflowStorage {
  saveRun(input: StoredWorkflowRunInput): void;
  loadRun(runId: string): StoredWorkflowRunRecord | undefined;
  listRuns(options?: { ownerSessionId?: string; status?: string }): StoredWorkflowRunRecord[];
  appendEvent(input: {
    runId: string;
    type: string;
    eventJson: string;
    createdAt: number;
  }): number;
  listEvents(runId: string): string[];
  claimRun(
    runId: string,
    ownerId: string,
  ): { ownerId: string; generation: number; claimedAt: number };
  finishClaim(runId: string, ownerId: string, status: string): void;
}

export interface WorkflowSessionEvents {
  latestEventSeq(): number;
  appendEvent(input: {
    type: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
  }): unknown;
}

export interface SessionWorkflowRunRepositoryOptions {
  workflows: WorkflowStorage;
  events: WorkflowSessionEvents;
  path: string;
  onDurableEvent?: (previousEventSeq: number) => void;
}

/** daemon 使用的 Workflow repository。事实写进和 Session/Run 相同的 SQLite。 */
export class SessionWorkflowRunRepository implements WorkflowRunRepository {
  readonly repositoryKey: string;
  private readonly ownerId = `workflow-owner:${process.pid}:${randomUUID()}`;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly options: SessionWorkflowRunRepositoryOptions) {
    this.repositoryKey = `sqlite:${options.path}`;
  }

  save(snapshot: WorkflowRunSnapshot): void {
    this.options.workflows.saveRun({
      runId: snapshot.runId,
      ownerSessionId: snapshot.ownerSession,
      ownerInputId: snapshot.ownerInput,
      ownerRunId: snapshot.ownerRun,
      status: snapshot.status,
      termination: snapshot.termination,
      snapshotJson: JSON.stringify(snapshot),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      taskAttempts: Object.values(snapshot.results).map((result) => ({
        taskId: result.taskId,
        attempt: result.attempts,
        status: result.status,
        payloadJson: JSON.stringify(result),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })),
    });
    this.changed(snapshot.runId);
  }

  appendEvent(event: WorkflowRunEvent): void {
    const snapshot = this.load(event.runId);
    const previousEventSeq = this.options.events.latestEventSeq();
    this.options.workflows.appendEvent({
      runId: event.runId,
      type: event.type,
      eventJson: JSON.stringify(event),
      createdAt: event.timestamp,
    });
    if (snapshot?.ownerSession) {
      this.options.events.appendEvent({
        type: `workflow.${event.type}`,
        sessionId: snapshot.ownerSession,
        payload: { event: JSON.parse(JSON.stringify(event)) as Record<string, unknown> },
      });
    }
    this.options.onDurableEvent?.(previousEventSeq);
    this.changed(event.runId);
  }

  loadEvents(runId: string): WorkflowRunEvent[] {
    return this.options.workflows.listEvents(runId).map(decodeWorkflowRunEvent);
  }

  load(runId: string): WorkflowRunSnapshot | undefined {
    const stored = this.options.workflows.loadRun(runId);
    return stored ? decodeWorkflowRunSnapshot(stored.snapshotJson) : undefined;
  }

  list(): WorkflowRunSnapshot[] {
    return this.options.workflows.listRuns().map((stored) => decodeWorkflowRunSnapshot(stored.snapshotJson));
  }

  listSummaries(): WorkflowRunSummary[] {
    return this.list().map(createWorkflowRunSummary);
  }

  latest(): WorkflowRunSnapshot | undefined {
    return this.list()[0];
  }

  claim(runId: string) {
    return this.options.workflows.claimRun(runId, this.ownerId);
  }

  finish(runId: string, status: WorkflowRunSnapshot["status"]): void {
    this.options.workflows.finishClaim(runId, this.ownerId, status);
  }

  async waitForChange(
    runId: string,
    after: number,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | undefined> {
    const version = this.versions.get(runId) ?? 0;
    const current = this.load(runId);
    if (!current || current.updatedAt > after) return current;
    return await new Promise((resolve, reject) => {
      const listeners = this.listeners.get(runId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        listeners.delete(changed);
        options.signal?.removeEventListener("abort", aborted);
        if (listeners.size === 0) this.listeners.delete(runId);
      };
      const changed = () => {
        finish();
        resolve(this.load(runId));
      };
      const aborted = () => {
        finish();
        reject(options.signal?.reason ?? new Error("Workflow wait aborted."));
      };
      listeners.add(changed);
      this.listeners.set(runId, listeners);
      if (options.signal?.aborted) {
        aborted();
        return;
      }
      options.signal?.addEventListener("abort", aborted, { once: true });
      const registered = this.load(runId);
      if (
        !registered ||
        registered.updatedAt > after ||
        (this.versions.get(runId) ?? 0) !== version
      ) {
        changed();
        return;
      }
      timer = setTimeout(() => {
        finish();
        resolve(this.load(runId));
      }, Math.max(1, options.timeoutMs));
      timer.unref?.();
    });
  }

  private notify(runId: string): void {
    for (const listener of [...(this.listeners.get(runId) ?? [])]) listener();
  }

  private changed(runId: string): void {
    this.versions.set(runId, (this.versions.get(runId) ?? 0) + 1);
    this.notify(runId);
  }
}
