import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { ScheduledRunRecord } from "@openharness/protocol";

import { ApplicationOwnerConflictError, SessionStore } from "../session-runtime/store.js";
import type { StorageContext } from "../database/storage-context.js";
import { ScheduleRepository } from "./schedule-repository.js";

function withRepository(
  test: (repository: ScheduleRepository, store: SessionStore) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "ohs-schedule-repository-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    test(new ScheduleRepository((store as any).storage), store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("ScheduleRepository", () => {
  const taskInput = {
    name: "original", prompt: "prompt", recurrence: "2030-01-01T00:00:00.000Z",
    recurrenceFormat: "once" as const, timezone: "UTC", destination: "standalone" as const,
  };
  const runInput = { taskId: "task", cause: "manual" as const, scheduledFor: 100 };

  it("replays every committed run transition including session link and read state", () => {
    withRepository((_repository, store) => {
      store.schedules.createTask({ ...taskInput, id: "task" });
      store.schedules.createRun({ ...runInput, id: "run" });
      store.schedules.updateRun("run", { status: "running" });
      store.sessions.create({ id: "session", cwd: process.cwd(), model: "test" });
      store.schedules.linkRunSession("run", "session");
      store.schedules.updateRun("run", { status: "succeeded", unread: true });
      store.schedules.updateRun("run", { unread: false });

      expect(store.conversations.listEvents().filter((event) => event.type.startsWith("scheduled.run."))
        .map((event) => [event.type, (event.payload.run as ScheduledRunRecord).status,
          (event.payload.run as ScheduledRunRecord).sessionId,
          (event.payload.run as ScheduledRunRecord).unread])).toEqual([
          ["scheduled.run.created", "queued", undefined, false],
          ["scheduled.run.updated", "running", undefined, false],
          ["scheduled.run.updated", "running", "session", false],
          ["scheduled.run.updated", "succeeded", "session", true],
          ["scheduled.run.updated", "succeeded", "session", false],
        ]);
    });
  });
  it("records a task deletion so replay can discard its old unread runs", () => {
    withRepository((_repository, store) => {
      store.schedules.createTask({ ...taskInput, id: "task" });
      store.schedules.createRun({ ...runInput, id: "run" });
      store.schedules.updateRun("run", { status: "succeeded", unread: true });
      const before = store.conversations.latestEventSeq();

      expect(store.schedules.deleteTask("task")).toBe(true);
      expect(store.schedules.getRun("run")).toBeUndefined();
      expect(store.conversations.listEvents({ afterSeq: before })).toMatchObject([
        { type: "scheduled.task.deleted", payload: { taskId: "task" } },
      ]);
    });
  });
  const writes: Array<[string, (store: SessionStore) => unknown]> = [
    ["createTask", (store) => store.schedules.createTask({ ...taskInput, id: "new-task" })],
    ["updateTask", (store) => store.schedules.updateTask("task", { name: "changed" })],
    ["deleteTask", (store) => store.schedules.deleteTask("task")],
    ["createRun", (store) => store.schedules.createRun({ ...runInput, id: "new-run" })],
    ["updateRun", (store) => store.schedules.updateRun("run", { status: "running" })],
    ["interruptActiveRuns", (store) => store.schedules.interruptActiveRuns("restart")],
    ["createScheduledTask", (store) => store.schedules.createTask({ ...taskInput, id: "new-task" })],
    ["updateScheduledTask", (store) => store.schedules.updateTask("task", { name: "changed" })],
    ["deleteScheduledTask", (store) => store.schedules.deleteTask("task")],
    ["createScheduledRun", (store) => store.schedules.createRun({ ...runInput, id: "new-run" })],
    ["updateScheduledRun", (store) => store.schedules.updateRun("run", { status: "running" })],
    ["interruptActiveScheduledRuns", (store) => store.schedules.interruptActiveRuns("restart")],
  ];

  describe.each(["before owner check", "after owner check"])("takeover %s", (timing) => {
    it.each(writes)("rejects %s without changing tasks or runs", (_name, write) => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-schedule-owner-"));
      const path = join(directory, "sessions.db");
      const first = new SessionStore({ path });
      const second = new SessionStore({ path });
      const storage = (first as unknown as { storage: StorageContext }).storage;
      const assertWritable = storage.assertWritable;
      try {
        first.acquireApplicationOwner({ ownerId: "first", pid: 1, now: 1, staleAfterMs: 1_000 });
        first.schedules.createTask({ ...taskInput, id: "task" });
        first.schedules.createRun({ ...runInput, id: "run" });
        const tasks = second.schedules.listTasks();
        const runs = second.schedules.listRuns();
        const takeOver = () => second.acquireApplicationOwner({ ownerId: "second", pid: 2, now: 2_000, staleAfterMs: 1_000 });
        if (timing === "before owner check") takeOver();
        else storage.assertWritable = () => {
          assertWritable();
          takeOver();
        };

        expect(() => write(first)).toThrow(
          timing === "before owner check" ? ApplicationOwnerConflictError : "database is locked",
        );
        expect(second.schedules.listTasks()).toEqual(tasks);
        expect(second.schedules.listRuns()).toEqual(runs);
      } finally {
        storage.assertWritable = assertWritable;
        first.close();
        second.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("reloads persisted task JSON and run state from disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-schedule-reload-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      const task = first.schedules.createTask({
        id: "task-reload",
        name: "reload",
        prompt: "reload",
        recurrence: "RRULE:FREQ=DAILY",
        recurrenceFormat: "rrule",
        timezone: "UTC",
        destination: "standalone",
        projectPaths: ["C:/repo"],
        pluginNames: ["plugin"],
        stopPolicy: { maxRuns: 2 },
      });
      first.schedules.createRun({
        id: "run-reload",
        taskId: task.id,
        cause: "scheduled",
        scheduledFor: 10,
      });
      first.close();

      const second = new SessionStore({ path });
      try {
        expect(second.schedules.getTask(task.id)).toMatchObject({
          projectPaths: ["C:/repo"],
          pluginNames: ["plugin"],
          stopPolicy: { maxRuns: 2 },
        });
        expect(second.schedules.getRun("run-reload")).toMatchObject({
          taskId: task.id,
          status: "queued",
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores and updates a task and its runs", () => {
    withRepository((repository) => {
      const task = repository.createTask({
        id: "task-1",
        name: "review",
        prompt: "Review changes",
        recurrence: "RRULE:FREQ=DAILY",
        recurrenceFormat: "rrule",
        timezone: "UTC",
        destination: "standalone",
        projectPaths: ["C:/repo"],
        skillNames: ["review"],
      });
      expect(task).toMatchObject({
        status: "active",
        executionMode: "local",
        overlapPolicy: "skip",
        missedRunPolicy: "skip",
        permissionProfile: { mode: "workspace_write" },
      });
      const run = repository.createRun({
        id: "run-1",
        taskId: task.id,
        cause: "manual",
        scheduledFor: 100,
      });
      repository.updateRun(run.id, { status: "running", unread: true });
      repository.updateTask(task.id, { nextRunAt: 200 });

      expect(repository.listTasks({ status: "active" })).toHaveLength(1);
      expect(
        repository.listRuns({ taskId: task.id, unread: true, limit: 999 }),
      ).toMatchObject([{ id: "run-1", status: "running" }]);
      expect(repository.getRun(run.id)?.unread).toBe(true);
    });
  });

  it("rolls back run deletion when deleting the task fails", () => {
    withRepository((repository, store) => {
      const task = repository.createTask({
        id: "task-delete",
        name: "delete",
        prompt: "delete",
        recurrence: "2030-01-01T00:00:00.000Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
      });
      const run = repository.createRun({
        id: "run-delete",
        taskId: task.id,
        cause: "manual",
        scheduledFor: 100,
      });
      const database = (store as any).storage.database.connection;
      database.exec(`
        CREATE TRIGGER fail_scheduled_task_delete
        BEFORE DELETE ON scheduled_task
        BEGIN
          SELECT RAISE(ABORT, 'forced task delete failure');
        END;
      `);

      expect(() => repository.deleteTask(task.id)).toThrow(
        "forced task delete failure",
      );
      expect(repository.getTask(task.id)?.id).toBe(task.id);
      expect(repository.getRun(run.id)?.id).toBe(run.id);
    });
  });

  it("preserves the existing permissive JSON fallback behavior", () => {
    withRepository((repository, store) => {
      const task = repository.createTask({
        id: "task-json",
        name: "json",
        prompt: "json",
        recurrence: "2030-01-01T00:00:00.000Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
      });
      (store as any).storage.database.connection
        .prepare(
          `UPDATE scheduled_task SET
          project_paths_json = ?, skill_names_json = ?,
          plugin_names_json = ?, permission_profile_json = ?, stop_policy_json = ?
          WHERE id = ?`,
        )
        .run("{broken", Buffer.from([1]), "{}", "null", "{broken", task.id);

      const loaded = repository.getTask(task.id) as any;
      expect(loaded.projectPaths).toEqual([]);
      expect(loaded.skillNames).toEqual([]);
      expect(loaded.pluginNames).toEqual({});
      expect(loaded.permissionProfile).toBeNull();
      expect(loaded.stopPolicy).toEqual({});
    });
  });

  it("supports null clearing, undefined preservation, and isolated results", () => {
    withRepository((repository) => {
      const task = repository.createTask({
        id: "task-update",
        name: "original",
        prompt: "prompt",
        recurrence: "2030-01-01T00:00:00.000Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
        nextRunAt: 200,
      });
      const returned = repository.updateTask(task.id, {
        name: undefined,
        lastRunAt: 100,
        nextRunAt: null,
      });
      returned.name = "caller mutation";

      expect(repository.getTask(task.id)).toMatchObject({
        name: "original",
        lastRunAt: 100,
      });
      expect(repository.getTask(task.id)?.nextRunAt).toBeUndefined();
      expect(() => repository.updateTask("missing", {})).toThrow(
        "Scheduled task not found: missing",
      );
      expect(() =>
        repository.createRun({
          taskId: "missing",
          cause: "manual",
          scheduledFor: 1,
        }),
      ).toThrow("Scheduled task not found: missing");
      expect(() => repository.updateRun("missing", {})).toThrow(
        "Scheduled run not found: missing",
      );
    });
  });

  it("bounds run lists and interrupts only active runs", () => {
    withRepository((repository, store) => {
      const task = repository.createTask({
        id: "task-runs",
        name: "runs",
        prompt: "runs",
        recurrence: "2030-01-01T00:00:00.000Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
      });
      const database = (store as any).storage.database.connection;
      const insert = database.prepare(
        "INSERT INTO scheduled_run (id, task_id, cause, status, scheduled_for, unread, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?, 0, ?, ?)",
      );
      database.transaction(() => {
        for (let index = 0; index < 501; index += 1) {
          const status =
            index === 0 ? "running" : index === 1 ? "succeeded" : "queued";
          insert.run(`run-${index}`, task.id, status, index, index, index);
        }
      })();

      expect(repository.listRuns()).toHaveLength(50);
      expect(repository.listRuns({ limit: 0 })).toHaveLength(1);
      expect(repository.listRuns({ limit: 999 })).toHaveLength(500);
      expect(repository.interruptActiveRuns("restart")).toBe(500);
      expect(repository.getRun("run-0")).toMatchObject({
        status: "interrupted",
        error: "restart",
        unread: true,
      });
      expect(repository.getRun("run-1")?.status).toBe("succeeded");
    });
  });

  it("deletes a task and all of its runs", () => {
    withRepository((repository) => {
      const task = repository.createTask({
        id: "task-delete-success",
        name: "delete",
        prompt: "delete",
        recurrence: "2030-01-01T00:00:00.000Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
      });
      const run = repository.createRun({
        id: "run-delete-success",
        taskId: task.id,
        cause: "manual",
        scheduledFor: 1,
      });

      expect(repository.deleteTask(task.id)).toBe(true);
      expect(repository.getTask(task.id)).toBeUndefined();
      expect(repository.getRun(run.id)).toBeUndefined();
      expect(repository.deleteTask(task.id)).toBe(false);
    });
  });
});
