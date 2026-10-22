import {
  createWorkflowRunSummary,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunEvent,
} from "@vykor/coordinator/workflow";

/** Ephemeral workflows use the same host lifecycle without producing files or durable claims. */
export class MemoryWorkflowRunRepository implements WorkflowRunRepository {
  readonly repositoryKey = `memory:${crypto.randomUUID()}`;
  private readonly runs = new Map<string, WorkflowRunSnapshot>();
  private readonly events = new Map<string, WorkflowRunEvent[]>();
  private readonly listeners = new Set<() => void>();
  save(run: WorkflowRunSnapshot): void {
    this.runs.set(run.runId, structuredClone(run));
    this.notify();
  }
  appendEvent(event: WorkflowRunEvent): void {
    const events = this.events.get(event.runId) ?? [];
    events.push(structuredClone(event));
    this.events.set(event.runId, events);
    this.notify();
  }
  load(id: string): WorkflowRunSnapshot | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }
  list(): WorkflowRunSnapshot[] {
    return [...this.runs.values()]
      .map((run) => structuredClone(run))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  listSummaries() {
    return this.list().map(createWorkflowRunSummary);
  }
  listWithDiagnostics() {
    return { snapshots: this.list(), diagnostics: [] };
  }
  latest() {
    return this.list()[0];
  }
  loadEvents(id: string) {
    return structuredClone(this.events.get(id) ?? []);
  }
  loadEventsWithDiagnostics(id: string) {
    return { events: this.loadEvents(id), diagnostics: [] };
  }
  claim(_id: string) {
    return {
      ownerId: this.repositoryKey,
      generation: 1,
      claimedAt: Date.now(),
    };
  }
  finish(_id: string, _status: WorkflowRunSnapshot["status"]): void {}
  async waitForChange(
    id: string,
    after: number,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) {
    const current = this.load(id);
    if (!current || current.updatedAt > after) return current;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        options.signal?.removeEventListener("abort", aborted);
      };
      const changed = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(options.signal?.reason ?? new Error("Workflow wait aborted"));
      };
      timer = setTimeout(changed, Math.max(1, options.timeoutMs));
      this.listeners.add(changed);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
    return this.load(id);
  }
  private notify() {
    for (const changed of [...this.listeners]) changed();
  }
}
