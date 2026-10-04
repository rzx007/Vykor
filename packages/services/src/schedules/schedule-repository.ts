import { randomUUID } from "node:crypto";

import type {
  AppendEventInput,
  CreateScheduledRunInput,
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledRunInput,
  UpdateScheduledTaskInput,
} from "@vykor/protocol";
import { and, desc, eq, exists, inArray, placeholder } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import { scheduledRuns, scheduledTasks, sessions } from "../session-runtime/schema.js";
import {
  encodeScheduleValue as encode,
  scheduledRunFromRow,
  scheduledTaskFromRow,
  withoutUndefined,
} from "./schedule-records.js";

export class ScheduleRepository {
  constructor(
    private readonly storage: StorageContext,
    private readonly appendEvent?: (input: AppendEventInput) => void,
  ) {}
  private get database() {
    return this.storage.database.orm;
  }

  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const timestamp = Date.now(),
        id = input.id ?? randomUUID();
      this.database.insert(scheduledTasks).values({
        id,
        name: input.name,
        description: input.description ?? null,
        prompt: input.prompt,
        recurrence: input.recurrence,
        recurrenceFormat: input.recurrenceFormat,
        timezone: input.timezone,
        status: input.status ?? "active",
        destination: input.destination,
        sessionId: input.sessionId ?? null,
        projectPathsJson: encode(input.projectPaths ?? []),
        executionMode: input.executionMode ?? "local",
        model: input.model ?? null,
        effort: input.effort ?? null,
        skillNamesJson: encode(input.skillNames ?? []),
        pluginNamesJson: encode(input.pluginNames ?? []),
        permissionProfileJson: encode(input.permissionProfile ?? { mode: "workspace_write" }),
        overlapPolicy: input.overlapPolicy ?? "skip",
        missedRunPolicy: input.missedRunPolicy ?? "skip",
        stopPolicyJson: input.stopPolicy ? encode(input.stopPolicy) : null,
        createdBy: input.createdBy ?? "user",
        createdFromSessionId: input.createdFromSessionId ?? null,
        lastRunAt: null,
        nextRunAt: input.nextRunAt ?? null,
        runCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      return this.getTask(id)!;
    })();
  }
  getTask(id: string): ScheduledTaskRecord | undefined {
    const row = this.database
      .select().from(scheduledTasks)
      .where(eq(scheduledTasks.id, id))
      .get();
    return row ? scheduledTaskFromRow(row) : undefined;
  }
  listTasks(
    options: { status?: ScheduledTaskRecord["status"] } = {},
  ): ScheduledTaskRecord[] {
    return this.database
      .select().from(scheduledTasks)
      .where(options.status ? eq(scheduledTasks.status, options.status) : undefined)
      .orderBy(desc(scheduledTasks.createdAt))
      .all()
      .map(scheduledTaskFromRow);
  }
  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const current = this.getTask(id);
      if (!current) throw new Error(`Scheduled task not found: ${id}`);
      const updated = {
        ...current,
        ...withoutUndefined(patch),
        updatedAt: Date.now(),
      } as ScheduledTaskRecord;
      if (patch.lastRunAt === null) delete updated.lastRunAt;
      if (patch.nextRunAt === null) delete updated.nextRunAt;
      this.database.update(scheduledTasks).set({
        name: updated.name,
        description: updated.description ?? null,
        prompt: updated.prompt,
        recurrence: updated.recurrence,
        recurrenceFormat: updated.recurrenceFormat,
        timezone: updated.timezone,
        status: updated.status,
        destination: updated.destination,
        sessionId: updated.sessionId ?? null,
        projectPathsJson: encode(updated.projectPaths),
        executionMode: updated.executionMode,
        model: updated.model ?? null,
        effort: updated.effort ?? null,
        skillNamesJson: encode(updated.skillNames),
        pluginNamesJson: encode(updated.pluginNames),
        permissionProfileJson: encode(updated.permissionProfile),
        overlapPolicy: updated.overlapPolicy,
        missedRunPolicy: updated.missedRunPolicy,
        stopPolicyJson: updated.stopPolicy ? encode(updated.stopPolicy) : null,
        createdBy: updated.createdBy,
        createdFromSessionId: updated.createdFromSessionId ?? null,
        lastRunAt: updated.lastRunAt ?? null,
        nextRunAt: updated.nextRunAt ?? null,
        runCount: updated.runCount,
        updatedAt: updated.updatedAt,
      }).where(eq(scheduledTasks.id, id)).run();
      return this.getTask(id)!;
    })();
  }
  deleteTask(id: string): boolean {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      this.database.delete(scheduledRuns).where(eq(scheduledRuns.taskId, id)).run();
      const deleted = this.database.delete(scheduledTasks).where(eq(scheduledTasks.id, id))
        .run().changes > 0;
      if (deleted) this.appendEvent?.({ type: "scheduled.task.deleted", payload: { taskId: id } });
      return deleted;
    });
  }
  createRun(input: CreateScheduledRunInput): ScheduledRunRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      if (!this.getTask(input.taskId))
        throw new Error(`Scheduled task not found: ${input.taskId}`);
      const timestamp = Date.now(),
        id = input.id ?? randomUUID();
      this.database.insert(scheduledRuns).values({
        id,
        taskId: input.taskId,
        cause: input.cause,
        status: "queued",
        scheduledFor: input.scheduledFor,
        unread: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      const run = this.getRun(id)!;
      this.appendEvent?.({ type: "scheduled.run.created", payload: { run } });
      return run;
    });
  }
  getRun(id: string): ScheduledRunRecord | undefined {
    const row = this.database
      .select().from(scheduledRuns)
      .where(eq(scheduledRuns.id, id))
      .get();
    return row ? scheduledRunFromRow(row) : undefined;
  }
  listRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    return this.database.select().from(scheduledRuns)
      .where(and(
        options.taskId ? eq(scheduledRuns.taskId, options.taskId) : undefined,
        options.unread !== undefined ? eq(scheduledRuns.unread, options.unread ? 1 : 0) : undefined,
      ))
      .orderBy(desc(scheduledRuns.createdAt))
      .limit(placeholder("limit"))
      .all({ limit })
      .map(scheduledRunFromRow);
  }
  updateRun(id: string, patch: UpdateScheduledRunInput): ScheduledRunRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const current = this.getRun(id);
      if (!current) throw new Error(`Scheduled run not found: ${id}`);
      const updated = {
        ...current,
        ...withoutUndefined(patch),
        updatedAt: Date.now(),
      } as ScheduledRunRecord;
      this.database.update(scheduledRuns).set({
        status: updated.status,
        sessionId: updated.sessionId ?? null,
        runId: updated.runId ?? null,
        summary: updated.summary ?? null,
        error: updated.error ?? null,
        unread: updated.unread ? 1 : 0,
        attentionReason: updated.attentionReason ?? null,
        startedAt: updated.startedAt ?? null,
        finishedAt: updated.finishedAt ?? null,
        updatedAt: updated.updatedAt,
      }).where(eq(scheduledRuns.id, id)).run();
      const run = this.getRun(id)!;
      this.appendEvent?.({ type: "scheduled.run.updated", payload: { run, previousStatus: current.status } });
      return run;
    });
  }
  linkRunSession(id: string, sessionId: string): ScheduledRunRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      if (!this.getRun(id)) throw new Error(`Scheduled run not found: ${id}`);
      this.database.update(scheduledRuns)
        .set({ sessionId, updatedAt: Date.now() })
        .where(and(
          eq(scheduledRuns.id, id),
          exists(this.database.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId))),
        ))
        .run();
      const run = this.getRun(id)!;
      this.appendEvent?.({ type: "scheduled.run.updated", payload: { run, previousStatus: run.status } });
      return run;
    });
  }
  interruptActiveRuns(reason: string): number {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const active = this.database.select({ id: scheduledRuns.id }).from(scheduledRuns)
        .where(inArray(scheduledRuns.status, ["queued", "running"]))
        .all();
      for (const { id } of active) {
        const previousStatus = this.getRun(id)!.status;
        const timestamp = Date.now();
        this.database.update(scheduledRuns).set({
          status: "interrupted",
          error: reason,
          unread: 1,
          finishedAt: timestamp,
          updatedAt: timestamp,
        }).where(eq(scheduledRuns.id, id)).run();
        this.appendEvent?.({
          type: "scheduled.run.updated",
          payload: { run: this.getRun(id)!, previousStatus },
        });
      }
      return active.length;
    });
  }
}
