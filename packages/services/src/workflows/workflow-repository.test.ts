import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { WorkflowRepository } from "./workflow-repository.js";

describe("WorkflowRepository", () => {
  it("saves and reloads a run with its task attempts", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-workflow-repository-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const repository = new WorkflowRepository((store as any).storage);
      repository.saveRun({
        runId: "workflow-1",
        status: "running",
        snapshotJson: '{"runId":"workflow-1","status":"running"}',
        createdAt: 10,
        updatedAt: 20,
        taskAttempts: [
          {
            taskId: "task-1",
            attempt: 1,
            status: "running",
            payloadJson: '{"taskId":"task-1"}',
            startedAt: 15,
          },
        ],
      });

      expect(repository.loadRun("workflow-1")).toMatchObject({
        runId: "workflow-1",
        status: "running",
        snapshotJson: '{"runId":"workflow-1","status":"running"}',
      });
      expect(repository.listRuns({ status: "running" })).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the run and old attempts when replacement fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-workflow-rollback-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const repository = new WorkflowRepository((store as any).storage);
      const original = {
        runId: "workflow-rollback",
        status: "running",
        snapshotJson: '{"version":"old"}',
        createdAt: 10,
        updatedAt: 20,
        taskAttempts: [{ taskId: "old", attempt: 1, status: "done", payloadJson: "{}", startedAt: 10 }],
      };
      repository.saveRun(original);
      const database = (store as any).storage.database.connection;
      database.exec(`CREATE TRIGGER fail_second_workflow_attempt BEFORE INSERT ON workflow_task_attempt WHEN NEW.task_id = 'second' BEGIN SELECT RAISE(ABORT, 'forced attempt failure'); END;`);

      expect(() => repository.saveRun({
        ...original,
        status: "completed",
        snapshotJson: '{"version":"new"}',
        updatedAt: 30,
        taskAttempts: [
          { taskId: "first", attempt: 1, status: "done", payloadJson: "{}", startedAt: 20 },
          { taskId: "second", attempt: 1, status: "done", payloadJson: "{}", startedAt: 20 },
        ],
      })).toThrow("forced attempt failure");

      expect(repository.loadRun(original.runId)?.snapshotJson).toBe('{"version":"old"}');
      expect(database.prepare("SELECT task_id FROM workflow_task_attempt WHERE workflow_run_id = ?").all(original.runId)).toEqual([{ task_id: "old" }]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("orders events and enforces claim ownership", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-workflow-claim-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const repository = new WorkflowRepository((store as any).storage);
      repository.saveRun({ runId: "workflow-claim", status: "running", snapshotJson: "{}", createdAt: 1, updatedAt: 1, taskAttempts: [] });
      expect(repository.appendEvent({ runId: "workflow-claim", type: "started", eventJson: '{"n":1}', createdAt: 1 })).toBe(1);
      expect(repository.appendEvent({ runId: "workflow-claim", type: "step", eventJson: '{"n":2}', createdAt: 2 })).toBe(2);
      expect(repository.listEvents("workflow-claim")).toEqual(['{"n":1}', '{"n":2}']);

      expect(repository.claimRun("workflow-claim", "owner-a")).toMatchObject({ ownerId: "owner-a", generation: 1 });
      expect(() => repository.claimRun("workflow-claim", "owner-a")).toThrow("already claimed");
      expect(repository.claimRun("workflow-claim", "owner-b")).toMatchObject({ ownerId: "owner-b", generation: 2 });
      expect(() => repository.finishClaim("workflow-claim", "owner-a", "failed")).toThrow("not active");
      repository.finishClaim("workflow-claim", "owner-b", "completed");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
