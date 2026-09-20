import {
  computeNextScheduledTime,
  validateScheduledRecurrence,
} from "@openharness/services";
import type {
  CreateScheduledRunInput,
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledRunInput,
  UpdateScheduledTaskInput,
} from "@openharness/protocol";

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DAEMON_RESTART_REASON =
  "Daemon restarted while the scheduled task was running";

export interface ScheduledTaskExecutionResult {
  runId: string;
  summary: string;
}

export interface ScheduleOperations {
  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord;
  getTask(id: string): ScheduledTaskRecord | undefined;
  listTasks(options?: { status?: ScheduledTaskRecord["status"] }): ScheduledTaskRecord[];
  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord;
  deleteTask(id: string): boolean;
  createRun(input: CreateScheduledRunInput): ScheduledRunRecord;
  listRuns(options?: { taskId?: string; unread?: boolean; limit?: number }): ScheduledRunRecord[];
  updateRun(id: string, patch: UpdateScheduledRunInput): ScheduledRunRecord;
  linkRunSession(id: string, sessionId: string): ScheduledRunRecord;
  interruptActiveRuns(reason: string): number;
}

export interface ScheduledTaskServiceOptions {
  schedules: ScheduleOperations;
  execute(
    task: ScheduledTaskRecord,
    run: ScheduledRunRecord,
    onSessionReady: (sessionId: string) => void,
  ): Promise<ScheduledTaskExecutionResult>;
}

export class ScheduledTaskService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<string, Promise<ScheduledRunRecord>>();
  private shuttingDown = false;

  constructor(private readonly options: ScheduledTaskServiceOptions) {
    options.schedules.interruptActiveRuns(DAEMON_RESTART_REASON);
    for (const task of options.schedules.listTasks()) {
      const missedRun =
        task.status === "active" &&
        task.missedRunPolicy === "run_once" &&
        task.nextRunAt !== undefined &&
        task.nextRunAt <= Date.now();
      const restored = missedRun
        ? options.schedules.updateTask(task.id, { nextRunAt: Date.now() })
        : task.status === "active"
          ? this.recomputeNext(task)
          : task;
      this.install(restored);
    }
  }

  status(): {
    running: true;
    tasks: number;
    active: number;
    paused: number;
    executing: number;
    unread: number;
  } {
    const tasks = this.listTasks();
    return {
      running: true,
      tasks: tasks.length,
      active: tasks.filter((task) => task.status === "active").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      executing: this.active.size,
      unread: this.options.schedules.listRuns({ unread: true, limit: 500 })
        .length,
    };
  }

  listTasks(
    options: { status?: ScheduledTaskRecord["status"] } = {},
  ): ScheduledTaskRecord[] {
    return this.options.schedules.listTasks(options);
  }

  getTask(id: string): ScheduledTaskRecord {
    const task = this.options.schedules.getTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    return task;
  }

  listRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    return this.options.schedules.listRuns(options);
  }

  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    this.assertAvailable();
    this.validateInput(input);
    const timestamp = Date.now();
    const nextRunAt =
      input.status === "paused" || input.status === "completed"
        ? undefined
        : computeNextScheduledTime(
            { format: input.recurrenceFormat, value: input.recurrence },
            {
              after: new Date(timestamp),
              anchor: new Date(timestamp),
              timezone: input.timezone,
            },
          );
    const task = this.options.schedules.createTask({
      ...input,
      nextRunAt,
    });
    this.install(task);
    return task;
  }

  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord {
    this.assertAvailable();
    const current = this.getTask(id);
    const candidate = { ...current, ...patch } as ScheduledTaskRecord;
    const scheduleChanged =
      patch.recurrence !== undefined ||
      patch.recurrenceFormat !== undefined ||
      patch.timezone !== undefined ||
      patch.status !== undefined;
    this.validateInput(candidate, {
      validateFutureSchedule: scheduleChanged && candidate.status === "active",
    });
    const nextRunAt =
      candidate.status === "active"
        ? scheduleChanged
          ? computeNextScheduledTime(
              {
                format: candidate.recurrenceFormat,
                value: candidate.recurrence,
              },
              {
                after: new Date(),
                anchor: new Date(candidate.createdAt),
                timezone: candidate.timezone,
              },
            )
          : current.nextRunAt
        : null;
    const task = this.options.schedules.updateTask(id, {
      ...patch,
      ...(scheduleChanged ? { nextRunAt } : {}),
    });
    this.install(task);
    return task;
  }

  removeTask(id: string): void {
    this.assertAvailable();
    if (this.active.has(id))
      throw new Error(`Scheduled task is running: ${id}`);
    this.clearTimer(id);
    if (!this.options.schedules.deleteTask(id)) {
      throw new Error(`Scheduled task not found: ${id}`);
    }
  }

  async trigger(id: string): Promise<ScheduledRunRecord> {
    this.assertAvailable();
    const task = this.getTask(id);
    return await this.startRun(task, "manual", Date.now());
  }

  markRunRead(id: string, unread = false): ScheduledRunRecord {
    return this.options.schedules.updateRun(id, { unread });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const id of this.timers.keys()) this.clearTimer(id);
    await Promise.allSettled(this.active.values());
  }

  private install(task: ScheduledTaskRecord): void {
    this.clearTimer(task.id);
    if (
      task.status !== "active" ||
      task.nextRunAt === undefined ||
      this.shuttingDown ||
      this.active.has(task.id)
    )
      return;
    const delay = Math.max(0, task.nextRunAt - Date.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(task.id);
        const latest = this.options.schedules.getTask(task.id);
        if (!latest || latest.status !== "active" || latest.nextRunAt !== task.nextRunAt) {
          if (latest) this.install(latest);
          return;
        }
        if (Date.now() < latest.nextRunAt!) {
          this.install(latest);
          return;
        }
        void this.startRun(latest, "scheduled", latest.nextRunAt!);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.timers.set(task.id, timer);
  }

  private async startRun(
    task: ScheduledTaskRecord,
    cause: ScheduledRunRecord["cause"],
    scheduledFor: number,
  ): Promise<ScheduledRunRecord> {
    const existing = this.active.get(task.id);
    if (existing) {
      if (task.overlapPolicy === "queue") {
        return await existing.then(() => {
          const latest = this.options.schedules.getTask(task.id);
          if (!latest)
            throw new Error(`Scheduled task not found: ${task.id}`);
          if (this.shuttingDown || latest.status !== "active") {
            return this.skipRun(
              task.id,
              cause,
              scheduledFor,
              this.shuttingDown
                ? "Skipped because the scheduled task service is shutting down"
                : `Skipped because the scheduled task is ${latest.status}`,
            );
          }
          return this.startRun(latest, cause, scheduledFor);
        });
      }
      return this.skipRun(
        task.id,
        cause,
        scheduledFor,
        "Skipped because the previous scheduled run is still active",
      );
    }
    const run = this.options.schedules.createRun({
      taskId: task.id,
      cause,
      scheduledFor,
    });
    const promise = this.executeRun(task, run);
    this.active.set(task.id, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(task.id);
      const latest = this.options.schedules.getTask(task.id);
      if (latest) this.install(latest);
    }
  }

  private async executeRun(
    task: ScheduledTaskRecord,
    run: ScheduledRunRecord,
  ): Promise<ScheduledRunRecord> {
    this.options.schedules.updateRun(run.id, {
      status: "running",
      startedAt: Date.now(),
    });
    try {
      const result = await this.options.execute(task, run, (sessionId) => {
        this.options.schedules.linkRunSession(run.id, sessionId);
      });
      const finished = this.options.schedules.updateRun(run.id, {
        status: "succeeded",
        runId: result.runId,
        summary: result.summary,
        unread: true,
        finishedAt: Date.now(),
      });
      this.finishTask(task.id, finished.finishedAt!, true);
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("requires user attention")
        ? "needs_attention"
        : "failed";
      const finished = this.options.schedules.updateRun(run.id, {
        status,
        error: message,
        ...(status === "needs_attention" ? { attentionReason: message } : {}),
        unread: true,
        finishedAt: Date.now(),
      });
      this.finishTask(task.id, finished.finishedAt!, false);
      return finished;
    }
  }

  private finishTask(
    taskId: string,
    finishedAt: number,
    succeeded: boolean,
  ): void {
    const latest = this.options.schedules.getTask(taskId);
    if (!latest) return;

    const runCount = latest.runCount + 1;
    if (latest.status === "paused" || latest.status === "completed") {
      this.options.schedules.updateTask(taskId, {
        runCount,
        lastRunAt: finishedAt,
        nextRunAt: null,
      });
      return;
    }

    let shouldComplete =
      latest.recurrenceFormat === "once" ||
      latest.stopPolicy?.runOnce ||
      (latest.stopPolicy?.stopWhenCompleted && succeeded) ||
      (latest.stopPolicy?.maxRuns !== undefined &&
        runCount >= latest.stopPolicy.maxRuns) ||
      (latest.stopPolicy?.expiresAt !== undefined &&
        finishedAt >= latest.stopPolicy.expiresAt);
    let nextRunAt: number | null = null;
    if (!shouldComplete) {
      try {
        nextRunAt = computeNextScheduledTime(
          { format: latest.recurrenceFormat, value: latest.recurrence },
          {
            after: new Date(finishedAt),
            anchor: new Date(latest.createdAt),
            timezone: latest.timezone,
          },
        );
      } catch {
        shouldComplete = true;
      }
    }
    this.options.schedules.updateTask(taskId, {
      runCount,
      lastRunAt: finishedAt,
      nextRunAt,
      ...(shouldComplete ? { status: "completed" } : {}),
    });
  }

  private recomputeNext(task: ScheduledTaskRecord): ScheduledTaskRecord {
    try {
      const nextRunAt = computeNextScheduledTime(
        { format: task.recurrenceFormat, value: task.recurrence },
        {
          after: new Date(),
          anchor: new Date(task.createdAt),
          timezone: task.timezone,
        },
      );
      return this.options.schedules.updateTask(task.id, { nextRunAt });
    } catch {
      return this.options.schedules.updateTask(task.id, {
        status: "completed",
        nextRunAt: null,
      });
    }
  }

  private skipRun(
    taskId: string,
    cause: ScheduledRunRecord["cause"],
    scheduledFor: number,
    summary: string,
  ): ScheduledRunRecord {
    const skipped = this.options.schedules.createRun({
      taskId,
      cause,
      scheduledFor,
    });
    return this.options.schedules.updateRun(skipped.id, {
      status: "skipped",
      summary,
      unread: true,
      finishedAt: Date.now(),
    });
  }

  private validateInput(
    input: CreateScheduledTaskInput | ScheduledTaskRecord,
    options: { validateFutureSchedule?: boolean } = {},
  ): void {
    if (!input.name.trim()) throw new Error("Scheduled task name is required");
    if (!input.prompt.trim())
      throw new Error("Scheduled task prompt is required");
    if (input.destination === "chat" && !input.sessionId) {
      throw new Error("A chat scheduled task requires sessionId");
    }
    if (
      input.executionMode === "worktree" &&
      input.destination !== "standalone"
    ) {
      throw new Error(
        "Worktree scheduled execution requires a standalone destination",
      );
    }
    if (
      input.executionMode === "worktree" &&
      (input.projectPaths?.length ?? 0) === 0
    ) {
      throw new Error(
        "Worktree scheduled execution requires at least one project path",
      );
    }
    if (
      input.destination === "chat" &&
      (Boolean(input.model?.trim()) ||
        Boolean(input.effort?.trim()) ||
        (input.permissionProfile !== undefined &&
          (input.permissionProfile.mode !== "workspace_write" ||
            input.permissionProfile.network !== undefined ||
            (input.permissionProfile.allowedTools?.length ?? 0) > 0 ||
            (input.permissionProfile.deniedTools?.length ?? 0) > 0)))
    ) {
      throw new Error(
        "Scheduled task runtime overrides require a standalone destination; chat tasks inherit their conversation runtime",
      );
    }
    if (
      input.permissionProfile &&
      !["read_only", "workspace_write", "full_access"].includes(
        input.permissionProfile.mode,
      )
    ) {
      throw new Error("Unknown scheduled task permission profile");
    }
    if (
      input.overlapPolicy &&
      !["skip", "queue"].includes(input.overlapPolicy)
    ) {
      throw new Error("Unknown scheduled task overlap policy");
    }
    if (
      input.missedRunPolicy &&
      !["skip", "run_once"].includes(input.missedRunPolicy)
    ) {
      throw new Error("Unknown scheduled task missed-run policy");
    }
    const shouldValidateFuture =
      options.validateFutureSchedule ??
      (input.status === "active" || input.status === undefined);
    if (shouldValidateFuture) {
      computeNextScheduledTime(
        { format: input.recurrenceFormat, value: input.recurrence },
        { after: new Date(), anchor: new Date(), timezone: input.timezone },
      );
    } else if (
      !validateScheduledRecurrence({
        format: input.recurrenceFormat,
        value: input.recurrence,
      })
    ) {
      throw new Error(`Invalid scheduled recurrence: ${input.recurrence}`);
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private assertAvailable(): void {
    if (this.shuttingDown)
      throw new Error("Scheduled task service is shutting down");
  }
}
