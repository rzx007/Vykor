import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getProjectConfigDir } from "@vykor/core";
import { createWorkflowPlan } from "./validation.js";
import {
  createWorkflowRunId,
  createWorkflowRunSnapshot,
  createWorkflowRunSummary,
  createWorkflowResultFromSnapshot,
} from "./snapshot.js";
import { runWorkflow } from "./runner.js";
import type {
  WorkflowRunEvent,
  WorkflowRunSummary,
  WorkflowRunSnapshot,
  WorkflowRunner,
  WorkflowRunResult,
  WorkflowSpec,
  WorkflowTaskRunResult,
} from "./model.js";

export interface FileWorkflowRunRepositoryOptions {
  cwd?: string;
  dir?: string;
}

/** Workflow 持久化入口。具体数据可以放在项目文件、SQLite 或其他宿主存储中。 */
export interface WorkflowRunRepository {
  readonly repositoryKey: string;
  save(snapshot: WorkflowRunSnapshot): void;
  appendEvent(event: WorkflowRunEvent): void;
  loadEvents(runId: string): WorkflowRunEvent[];
  load(runId: string): WorkflowRunSnapshot | undefined;
  list(): WorkflowRunSnapshot[];
  listSummaries(): WorkflowRunSummary[];
  latest(): WorkflowRunSnapshot | undefined;
  claim(runId: string): { ownerId: string; generation: number; claimedAt: number };
  finish(runId: string, status: WorkflowRunSnapshot["status"]): void;
  waitForChange(runId: string, after: number, options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<WorkflowRunSnapshot | undefined>;
}

export interface RunPersistentWorkflowOptions {
  runId?: string;
  ownerSession?: string;
  ownerInput?: string;
  ownerRun?: string;
  store: WorkflowRunRepository;
  onEvent?: (event: WorkflowRunEvent) => void;
  /** Prevent a cancelled owner from writing a later running/completed snapshot. */
  signal?: AbortSignal;
}

export interface ResumePersistentWorkflowOptions {
  store: WorkflowRunRepository;
  onEvent?: (event: WorkflowRunEvent) => void;
  signal?: AbortSignal;
}

export interface CancelPersistentWorkflowOptions {
  store: WorkflowRunRepository;
  reason?: string;
  stopTask?: (taskId: string) => Promise<unknown>;
  onEvent?: (event: WorkflowRunEvent) => void;
}

interface ActiveWorkflowRun {
  stopReason?: string;
}

const activeWorkflowRuns = new Map<string, Set<ActiveWorkflowRun>>();

export function getWorkflowRunsDir(cwd?: string): string {
  return join(getProjectConfigDir(cwd), "workflows");
}

export class FileWorkflowRunRepository implements WorkflowRunRepository {
  readonly dir: string;
  readonly repositoryKey: string;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: FileWorkflowRunRepositoryOptions = {}) {
    this.dir = options.dir ?? getWorkflowRunsDir(options.cwd);
    this.repositoryKey = `file:${this.dir}`;
  }

  pathFor(runId: string): string {
    return join(this.dir, `${sanitizeRunId(runId)}.json`);
  }

  eventPathFor(runId: string): string {
    return join(this.dir, `${sanitizeRunId(runId)}.events.ndjson`);
  }

  save(snapshot: WorkflowRunSnapshot): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.pathFor(snapshot.runId), JSON.stringify(snapshot, null, 2) + "\n");
    this.notify(snapshot.runId);
  }

  appendEvent(event: WorkflowRunEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.eventPathFor(event.runId), JSON.stringify(event) + "\n", "utf-8");
    this.notify(event.runId);
  }

  loadEvents(runId: string): WorkflowRunEvent[] {
    const path = this.eventPathFor(runId);
    if (!existsSync(path)) return [];
    const events: WorkflowRunEvent[] = [];
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        events.push(decodeWorkflowRunEvent(line));
      } catch {
        // Ignore corrupt event lines so a partial append doesn't hide the usable timeline.
      }
    }
    return events;
  }

  load(runId: string): WorkflowRunSnapshot | undefined {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return undefined;
    return decodeWorkflowRunSnapshot(readFileSync(path, "utf-8"));
  }

  list(): WorkflowRunSnapshot[] {
    if (!existsSync(this.dir)) return [];
    const snapshots: WorkflowRunSnapshot[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const snapshot = decodeWorkflowRunSnapshot(readFileSync(join(this.dir, entry.name), "utf-8"));
        snapshots.push(snapshot);
      } catch {
        // Ignore corrupt or partial files so one bad snapshot doesn't hide the rest.
      }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listSummaries(): WorkflowRunSummary[] {
    return this.list().map(createWorkflowRunSummary);
  }

  latest(): WorkflowRunSnapshot | undefined {
    return this.list()[0];
  }

  claim(_runId: string): { ownerId: string; generation: number; claimedAt: number } {
    return { ownerId: `file:${process.pid}`, generation: 1, claimedAt: Date.now() };
  }

  finish(_runId: string, _status: WorkflowRunSnapshot["status"]): void {}

  async waitForChange(
    runId: string,
    after: number,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | undefined> {
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
      if (!registered || registered.updatedAt > after) {
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

  async resume(runId: string, runner: WorkflowRunner): Promise<WorkflowRunResult> {
    const snapshot = this.load(runId);
    if (!snapshot) throw new Error(`Workflow run not found: ${runId}`);
    return resumePersistentWorkflow(snapshot, runner, { store: this });
  }

  async resumeLatest(runner: WorkflowRunner): Promise<WorkflowRunResult> {
    const snapshot = this.latest();
    if (!snapshot) throw new Error("No workflow runs found");
    return resumePersistentWorkflow(snapshot, runner, { store: this });
  }
}

export async function runPersistentWorkflow(
  spec: WorkflowSpec,
  runner: WorkflowRunner,
  options: RunPersistentWorkflowOptions,
): Promise<WorkflowRunResult> {
  const store = options.store;
  const runId = options.runId ?? createWorkflowRunId();
  if (store.load(runId)) throw new Error(`Workflow run already exists: ${runId}`);
  const active = registerActiveWorkflow(store, runId);
  let claimed = false;
  try {
    return await runWorkflow(spec, runner, {
      runId,
      ownerSession: options.ownerSession,
      ownerInput: options.ownerInput,
      ownerRun: options.ownerRun,
      shouldStop: () => active.stopReason,
      onSnapshot: (snapshot) => {
        if (!options.signal?.aborted && !active.stopReason) {
          store.save(snapshot);
          if (!claimed) {
            store.claim(runId);
            claimed = true;
          }
          if (snapshot.status !== "running") store.finish(runId, snapshot.status);
        }
      },
      onEvent: (event) => {
        if (options.signal?.aborted || active.stopReason) return;
        store.appendEvent(event);
        options.onEvent?.(event);
      },
    });
  } finally {
    unregisterActiveWorkflow(store, runId, active);
  }
}

export async function resumePersistentWorkflow(
  snapshotOrRunId: WorkflowRunSnapshot | string,
  runner: WorkflowRunner,
  options: ResumePersistentWorkflowOptions,
): Promise<WorkflowRunResult> {
  const store = options.store;
  const snapshot =
    typeof snapshotOrRunId === "string"
      ? store.load(snapshotOrRunId)
      : snapshotOrRunId;
  if (!snapshot) {
    throw new Error(`Workflow run not found: ${snapshotOrRunId}`);
  }
  if (snapshot.status !== "running") {
    return createWorkflowResultFromSnapshot(snapshot);
  }
  const active = registerActiveWorkflow(store, snapshot.runId);
  let claimed = false;
  try {
    return await runWorkflow(snapshot.spec, runner, {
      runId: snapshot.runId,
      ownerSession: snapshot.ownerSession,
      ownerInput: snapshot.ownerInput,
      ownerRun: snapshot.ownerRun,
      shouldStop: () => active.stopReason,
      createdAt: snapshot.createdAt,
      initialResults: snapshot.results,
      initialRunningTasks: snapshot.runningTasks,
      onSnapshot: (next) => {
        if (!options.signal?.aborted && !active.stopReason) {
          store.save(next);
          if (!claimed) {
            store.claim(snapshot.runId);
            claimed = true;
          }
          if (next.status !== "running") store.finish(snapshot.runId, next.status);
        }
      },
      onEvent: (event) => {
        if (options.signal?.aborted || active.stopReason) return;
        store.appendEvent(event);
        options.onEvent?.(event);
      },
    });
  } finally {
    unregisterActiveWorkflow(store, snapshot.runId, active);
  }
}

export async function cancelPersistentWorkflow(
  snapshotOrRunId: WorkflowRunSnapshot | string,
  options: CancelPersistentWorkflowOptions,
): Promise<WorkflowRunResult> {
  const store = options.store;
  const snapshot =
    typeof snapshotOrRunId === "string"
      ? store.load(snapshotOrRunId)
      : snapshotOrRunId;
  if (!snapshot) {
    throw new Error(`Workflow run not found: ${snapshotOrRunId}`);
  }
  if (snapshot.status !== "running") {
    return createWorkflowResultFromSnapshot(snapshot);
  }

  const reason = options.reason ?? "Workflow cancelled";
  requestActiveWorkflowStop(store, snapshot.runId, reason);
  const stopErrors: Record<string, string> = {};
  for (const runningTask of Object.values(snapshot.runningTasks)) {
    const workerTaskId = workerTaskIdFromMetadata(runningTask.metadata);
    if (!workerTaskId || !options.stopTask) continue;
    try {
      await options.stopTask(workerTaskId);
    } catch (error) {
      stopErrors[workerTaskId] = error instanceof Error ? error.message : String(error);
    }
  }

  const plan = createWorkflowPlan(snapshot.spec);
  const results = new Map<string, WorkflowTaskRunResult>(Object.entries(snapshot.results));
  const now = Date.now();
  for (const taskId of plan.executionOrder) {
    if (results.has(taskId)) continue;
    const runningTask = snapshot.runningTasks[taskId];
    const workerTaskId = workerTaskIdFromMetadata(runningTask?.metadata);
    if (runningTask) {
      results.set(taskId, {
        taskId,
        status: "killed",
        summary: reason,
        attempts: runningTask.attempt,
        dependencies: [...(plan.dependencyMap[taskId] ?? [])],
        startedAt: runningTask.startedAt,
        finishedAt: now,
        metadata: {
          ...runningTask.metadata,
          cancelled: true,
          ...(workerTaskId && stopErrors[workerTaskId] ? { stopError: stopErrors[workerTaskId] } : {}),
        },
      });
    } else {
      results.set(taskId, {
        taskId,
        status: "skipped",
        summary: reason,
        attempts: 0,
        dependencies: [...(plan.dependencyMap[taskId] ?? [])],
        startedAt: now,
        finishedAt: now,
        skippedReason: reason,
      });
    }
  }

  const cancelledSnapshot = createWorkflowRunSnapshot({
    runId: snapshot.runId,
    ownerSession: snapshot.ownerSession,
    ownerInput: snapshot.ownerInput,
    ownerRun: snapshot.ownerRun,
    status: "failed",
    termination: "cancelled",
    summary: reason,
    spec: snapshot.spec,
    plan,
    results,
    running: new Set(),
    runningTasks: new Map(),
    blockedTasks: new Map(),
    createdAt: snapshot.createdAt,
  });
  store.save(cancelledSnapshot);
  store.finish(snapshot.runId, cancelledSnapshot.status);
  const event: WorkflowRunEvent = {
    version: 1,
    runId: snapshot.runId,
    type: "workflow_cancelled",
    timestamp: now,
    status: "failed",
    summary: reason,
  };
  store.appendEvent(event);
  options.onEvent?.(event);
  return createWorkflowResultFromSnapshot(cancelledSnapshot);
}

function activeWorkflowKey(store: WorkflowRunRepository, runId: string): string {
  return `${store.repositoryKey}\0${runId}`;
}

function registerActiveWorkflow(store: WorkflowRunRepository, runId: string): ActiveWorkflowRun {
  const key = activeWorkflowKey(store, runId);
  const runs = activeWorkflowRuns.get(key) ?? new Set<ActiveWorkflowRun>();
  const active: ActiveWorkflowRun = {};
  runs.add(active);
  activeWorkflowRuns.set(key, runs);
  return active;
}

function unregisterActiveWorkflow(
  store: WorkflowRunRepository,
  runId: string,
  active: ActiveWorkflowRun,
): void {
  const key = activeWorkflowKey(store, runId);
  const runs = activeWorkflowRuns.get(key);
  if (!runs) return;
  runs.delete(active);
  if (runs.size === 0) activeWorkflowRuns.delete(key);
}

function requestActiveWorkflowStop(store: WorkflowRunRepository, runId: string, reason: string): void {
  for (const active of activeWorkflowRuns.get(activeWorkflowKey(store, runId)) ?? []) {
    active.stopReason = reason;
  }
}

function sanitizeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`Invalid workflow run id '${runId}'`);
  }
  return runId;
}

function workerTaskIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  return typeof metadata?.workerTaskId === "string" ? metadata.workerTaskId : undefined;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

export function decodeWorkflowRunSnapshot(text: string): WorkflowRunSnapshot {
  const value = JSON.parse(text) as unknown;
  if (!isWorkflowRunSnapshot(value)) {
    throw new Error("Invalid workflow run snapshot");
  }
  return value;
}

export function decodeWorkflowRunEvent(text: string): WorkflowRunEvent {
  const value = JSON.parse(text) as unknown;
  if (!isWorkflowRunEvent(value)) throw new Error("Invalid workflow run event");
  return value;
}

function isWorkflowRunSnapshot(value: unknown): value is WorkflowRunSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowRunSnapshot;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    (candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed") &&
    (candidate.termination === undefined || candidate.termination === "cancelled") &&
    typeof candidate.summary === "string" &&
    typeof candidate.spec === "object" &&
    candidate.spec !== null &&
    typeof candidate.plan === "object" &&
    candidate.plan !== null &&
    typeof candidate.results === "object" &&
    candidate.results !== null &&
    Array.isArray(candidate.orderedResults) &&
    Array.isArray(candidate.pendingTaskIds) &&
    Array.isArray(candidate.blockedTaskIds) &&
    typeof candidate.blockedTasks === "object" && candidate.blockedTasks !== null &&
    Array.isArray(candidate.runningTaskIds) &&
    typeof candidate.runningTasks === "object" && candidate.runningTasks !== null &&
    typeof candidate.budget === "object" && candidate.budget !== null &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowRunEvent;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "number"
  );
}
