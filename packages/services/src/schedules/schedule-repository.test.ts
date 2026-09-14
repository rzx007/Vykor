import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
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
      expect(repository.listRuns({ taskId: task.id, unread: true, limit: 999 }))
        .toMatchObject([{ id: "run-1", status: "running" }]);
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
        .prepare(`UPDATE scheduled_task SET
          project_paths_json = ?, skill_names_json = ?,
          plugin_names_json = ?, permission_profile_json = ?, stop_policy_json = ?
          WHERE id = ?`)
        .run("{broken", Buffer.from([1]), "{}", "null", "{broken", task.id);

      const loaded = repository.getTask(task.id) as any;
      expect(loaded.projectPaths).toEqual([]);
      expect(loaded.skillNames).toEqual([]);
      expect(loaded.pluginNames).toEqual({});
      expect(loaded.permissionProfile).toBeNull();
      expect(loaded.stopPolicy).toEqual({});
    });
  });
});
