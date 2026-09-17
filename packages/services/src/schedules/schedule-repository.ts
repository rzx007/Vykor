import { randomUUID } from "node:crypto";
import type {
  CreateScheduledRunInput,
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledRunInput,
  UpdateScheduledTaskInput,
} from "@openharness/protocol";
import type { StorageContext } from "../database/storage-context.js";
import {
  encodeScheduleValue as encode,
  scheduledRunFromRow,
  scheduledTaskFromRow,
  withoutUndefined,
} from "./schedule-records.js";

export class ScheduleRepository {
  constructor(private readonly storage: StorageContext) {}
  private get database() {
    return this.storage.database.connection;
  }

  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      const timestamp = Date.now(),
        id = input.id ?? randomUUID();
      this.database
        .prepare(
          `INSERT INTO scheduled_task (id, name, description, prompt, recurrence, recurrence_format, timezone, status, destination, session_id, project_paths_json, execution_mode, model, effort, skill_names_json, plugin_names_json, permission_profile_json, overlap_policy, missed_run_policy, stop_policy_json, created_by, created_from_session_id, last_run_at, next_run_at, run_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
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
      return this.getTask(id)!;
    })();
  }
  getTask(id: string): ScheduledTaskRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduled_task WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? scheduledTaskFromRow(row) : undefined;
  }
  listTasks(
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
  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord {
    return this.database.transaction(() => {
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
      this.database
        .prepare(
          `UPDATE scheduled_task SET name = ?, description = ?, prompt = ?, recurrence = ?, recurrence_format = ?, timezone = ?, status = ?, destination = ?, session_id = ?, project_paths_json = ?, execution_mode = ?, model = ?, effort = ?, skill_names_json = ?, plugin_names_json = ?, permission_profile_json = ?, overlap_policy = ?, missed_run_policy = ?, stop_policy_json = ?, created_by = ?, created_from_session_id = ?, last_run_at = ?, next_run_at = ?, run_count = ?, updated_at = ? WHERE id = ?`,
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
      return this.getTask(id)!;
    })();
  }
  deleteTask(id: string): boolean {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      this.database
        .prepare("DELETE FROM scheduled_run WHERE task_id = ?")
        .run(id);
      return (
        this.database.prepare("DELETE FROM scheduled_task WHERE id = ?").run(id)
          .changes > 0
      );
    })();
  }
  createRun(input: CreateScheduledRunInput): ScheduledRunRecord {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      if (!this.getTask(input.taskId))
        throw new Error(`Scheduled task not found: ${input.taskId}`);
      const timestamp = Date.now(),
        id = input.id ?? randomUUID();
      this.database
        .prepare(
          "INSERT INTO scheduled_run (id, task_id, cause, status, scheduled_for, unread, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?)",
        )
        .run(
          id,
          input.taskId,
          input.cause,
          input.scheduledFor,
          timestamp,
          timestamp,
        );
      return this.getRun(id)!;
    })();
  }
  getRun(id: string): ScheduledRunRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduled_run WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? scheduledRunFromRow(row) : undefined;
  }
  listRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    let sql = "SELECT * FROM scheduled_run";
    const conditions: string[] = [],
      values: Array<string | number> = [];
    if (options.taskId) {
      conditions.push("task_id = ?");
      values.push(options.taskId);
    }
    if (options.unread !== undefined) {
      conditions.push("unread = ?");
      values.push(options.unread ? 1 : 0);
    }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC LIMIT ?";
    values.push(limit);
    return (
      this.database.prepare(sql).all(...values) as Array<
        Record<string, unknown>
      >
    ).map(scheduledRunFromRow);
  }
  updateRun(id: string, patch: UpdateScheduledRunInput): ScheduledRunRecord {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      const current = this.getRun(id);
      if (!current) throw new Error(`Scheduled run not found: ${id}`);
      const updated = {
        ...current,
        ...withoutUndefined(patch),
        updatedAt: Date.now(),
      } as ScheduledRunRecord;
      this.database
        .prepare(
          "UPDATE scheduled_run SET status = ?, session_id = ?, run_id = ?, summary = ?, error = ?, unread = ?, attention_reason = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?",
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
      return this.getRun(id)!;
    })();
  }
  linkRunSession(id: string, sessionId: string): ScheduledRunRecord {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      if (!this.getRun(id)) throw new Error(`Scheduled run not found: ${id}`);
      this.database.prepare(
        "UPDATE scheduled_run SET session_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM session WHERE id = ?)",
      ).run(sessionId, Date.now(), id, sessionId);
      return this.getRun(id)!;
    })();
  }
  interruptActiveRuns(reason: string): number {
    return this.database.transaction(() => {
      this.storage.assertWritable();
      return this.database
        .prepare(
          "UPDATE scheduled_run SET status = 'interrupted', error = ?, unread = 1, finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running')",
        )
        .run(reason, Date.now(), Date.now()).changes;
    })();
  }
}
