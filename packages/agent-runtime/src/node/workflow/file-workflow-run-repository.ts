import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectConfigDir } from "@vykor/host-config";
import {
  createWorkflowRunSummary,
  decodeWorkflowRunEvent,
  decodeWorkflowRunSnapshot,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunEvent,
  type WorkflowRunSummary,
  type WorkflowSnapshotReadResult,
  type WorkflowReadDiagnostic,
  type WorkflowEventReadResult,
} from "@vykor/coordinator/workflow";
export interface FileWorkflowRunRepositoryOptions {
  cwd?: string;
  dir?: string;
}
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
    atomicWrite(
      this.pathFor(snapshot.runId),
      JSON.stringify(snapshot, null, 2) + "\n",
    );
    this.notify(snapshot.runId);
  }

  appendEvent(event: WorkflowRunEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(
      this.eventPathFor(event.runId),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
    this.notify(event.runId);
  }

  loadEvents(runId: string): WorkflowRunEvent[] {
    return this.loadEventsWithDiagnostics(runId).events;
  }

  loadEventsWithDiagnostics(runId: string): WorkflowEventReadResult {
    const path = this.eventPathFor(runId);
    if (!existsSync(path)) return { events: [], diagnostics: [] };
    const events: WorkflowRunEvent[] = [];
    const diagnostics: WorkflowReadDiagnostic[] = [];
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        const event = decodeWorkflowRunEvent(line);
        if (event.runId !== runId)
          throw new Error("Workflow event identity mismatch");
        events.push(event);
      } catch {
        // Report a safe diagnostic so a partial append doesn't hide the usable timeline.
        diagnostics.push({
          code: "invalid_workflow_event",
          sourceId: `${runId}:event:${index + 1}`,
        });
      }
    }
    return { events, diagnostics };
  }

  load(runId: string): WorkflowRunSnapshot | undefined {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return undefined;
    return decodeWorkflowRunSnapshot(readFileSync(path, "utf-8"));
  }

  list(): WorkflowRunSnapshot[] {
    return this.listWithDiagnostics().snapshots;
  }

  listWithDiagnostics(): WorkflowSnapshotReadResult {
    if (!existsSync(this.dir)) return { snapshots: [], diagnostics: [] };
    const snapshots: WorkflowRunSnapshot[] = [];
    const diagnostics: WorkflowReadDiagnostic[] = [];
    const entries = readdirSync(this.dir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const snapshot = decodeWorkflowRunSnapshot(
          readFileSync(join(this.dir, entry.name), "utf-8"),
        );
        if (snapshot.runId !== entry.name.slice(0, -".json".length)) {
          throw new Error("Workflow snapshot identity mismatch");
        }
        snapshots.push(snapshot);
      } catch {
        // Ignore corrupt or partial files so one bad snapshot doesn't hide the rest.
        diagnostics.push({
          code: "invalid_workflow_snapshot",
          sourceId: entry.name.slice(0, -".json".length),
        });
      }
    }
    return {
      snapshots: snapshots.sort((a, b) => b.updatedAt - a.updatedAt),
      diagnostics,
    };
  }

  listSummaries(): WorkflowRunSummary[] {
    return this.list().map(createWorkflowRunSummary);
  }

  latest(): WorkflowRunSnapshot | undefined {
    return this.list()[0];
  }

  claim(_runId: string): {
    ownerId: string;
    generation: number;
    claimedAt: number;
  } {
    return {
      ownerId: `file:${process.pid}`,
      generation: 1,
      claimedAt: Date.now(),
    };
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
      timer = setTimeout(
        () => {
          finish();
          resolve(this.load(runId));
        },
        Math.max(1, options.timeoutMs),
      );
      timer.unref?.();
    });
  }

  private notify(runId: string): void {
    for (const listener of [...(this.listeners.get(runId) ?? [])]) listener();
  }
}

function sanitizeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`Invalid workflow run id '${runId}'`);
  }
  return runId;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}
