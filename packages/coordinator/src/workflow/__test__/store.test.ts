import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowTaskRunResult,
} from "../index.js";
import { cancelPersistentWorkflow, FileWorkflowRunRepository, resumePersistentWorkflow, runPersistentWorkflow } from "../index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-workflow-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("FileWorkflowRunRepository", () => {
  it("persists running snapshots before the workflow completes", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    let unblock: (() => void) | undefined;

    const workflow = runPersistentWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "research" }],
      },
      async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return { summary: "research done" };
      },
      { store, runId: "run-progress" },
    );

    await vi.waitFor(() => {
      const snapshot = store.load("run-progress");
      expect(snapshot?.status).toBe("running");
      expect(snapshot?.runningTaskIds).toEqual(["research"]);
      expect(snapshot?.pendingTaskIds).toEqual([]);
    });

    unblock?.();
    const result = await workflow;
    expect(result.status).toBe("completed");
    expect(store.loadEvents("run-progress").map((event) => event.type)).toContain("task_started");
    expect(store.loadEvents("run-progress").map((event) => event.type)).toContain("workflow_finished");
  });

  it("does not overwrite a terminal cancellation after its owner aborts", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    const controller = new AbortController();
    let unblock: (() => void) | undefined;
    const workflow = runPersistentWorkflow(
      { mode: "parallel", tasks: [{ id: "research" }] },
      async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return { summary: "late completion" };
      },
      { store, runId: "run-owner-abort", signal: controller.signal },
    );

    await vi.waitFor(() => expect(store.load("run-owner-abort")?.status).toBe("running"));
    controller.abort(new Error("parent interrupted"));
    await cancelPersistentWorkflow("run-owner-abort", { store, reason: "Parent session interrupted" });
    unblock?.();
    await workflow;

    expect(store.load("run-owner-abort")).toMatchObject({
      status: "failed",
      summary: "Parent session interrupted",
      runningTaskIds: [],
    });
    expect(store.loadEvents("run-owner-abort").map((event) => event.type)).not.toContain("workflow_finished");
  });

  it("loads and lists completed workflow snapshots", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });

    const result = await runPersistentWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "verify" }],
      },
      ({ task }) => ({
        summary: `${task.id} done`,
        result: `${task.id} result`,
        metadata: { task: task.id },
      }),
      { store, runId: "run-complete" },
    );

    expect(result.runId).toBe("run-complete");
    const snapshot = store.load("run-complete");
    expect(snapshot).toMatchObject({
      version: 1,
      runId: "run-complete",
      status: "completed",
      summary: "2/2 tasks completed",
      pendingTaskIds: [],
      runningTaskIds: [],
      plan: { mode: "pipeline", maxConcurrency: 1 },
    });
    expect(snapshot?.orderedResults.map((task) => task.taskId)).toEqual(["research", "verify"]);
    expect(snapshot?.results.verify?.result).toBe("verify result");
    expect(store.list().map((item) => item.runId)).toEqual(["run-complete"]);
    expect(store.listSummaries()).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        status: "completed",
        mode: "pipeline",
        totalTasks: 2,
        completedTasks: 2,
        failedTasks: 0,
        pendingTasks: 0,
        runningTasks: 0,
      }),
    ]);
  });

  it("rejects unsafe run ids", () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    expect(() => store.pathFor("../oops")).toThrow("Invalid workflow run id");
  });

  it("resumes a running snapshot without rerunning completed tasks", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    const spec = {
      mode: "pipeline" as const,
      tasks: [{ id: "research" }, { id: "implement" }, { id: "verify" }],
    };
    const plan = createWorkflowPlan(spec);
    const researchResult: WorkflowTaskRunResult = {
      taskId: "research",
      status: "completed",
      summary: "research done",
      result: "research result",
      attempts: 1,
      dependencies: [],
      startedAt: 1,
      finishedAt: 2,
    };
    store.save(createWorkflowRunSnapshot({
      runId: "run-resume",
      status: "running",
      summary: "resume point",
      spec,
      plan,
      results: new Map([["research", researchResult]]),
      running: new Set(["implement"]),
      runningTasks: new Map([[
        "implement",
        {
          taskId: "implement",
          attempt: 1,
          dependencies: ["research"],
          startedAt: 3,
          summary: "Waiting for task task_implement",
          metadata: { workerTaskId: "task_implement" },
        },
      ]]),
      createdAt: 100,
    }));

    const executed: string[] = [];
    const result = await resumePersistentWorkflow(
      "run-resume",
      ({ task, pipelineInput, resumeFrom }) => {
        executed.push(task.id);
        if (task.id === "implement") {
          expect(pipelineInput?.taskId).toBe("research");
          expect(resumeFrom?.metadata?.workerTaskId).toBe("task_implement");
        }
        if (task.id === "verify") {
          expect(pipelineInput?.taskId).toBe("implement");
        }
        return { summary: `${task.id} done`, result: `${task.id} result` };
      },
      { store },
    );

    expect(executed).toEqual(["implement", "verify"]);
    expect(result.runId).toBe("run-resume");
    expect(result.results.research).toEqual(researchResult);
    expect(result.results.implement?.status).toBe("completed");
    expect(result.results.verify?.status).toBe("completed");

    const snapshot = store.load("run-resume");
    expect(snapshot).toMatchObject({
      status: "completed",
      summary: "3/3 tasks completed",
      createdAt: 100,
      pendingTaskIds: [],
      runningTaskIds: [],
    });
    expect(snapshot?.orderedResults.map((task) => task.taskId)).toEqual(["research", "implement", "verify"]);
  });

  it("returns terminal snapshots without rerunning workers", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    await runPersistentWorkflow(
      { mode: "parallel", tasks: [{ id: "done" }] },
      () => ({ summary: "done" }),
      { store, runId: "terminal" },
    );

    const result = await resumePersistentWorkflow(
      "terminal",
      () => {
        throw new Error("should not run");
      },
      { store },
    );

    expect(result.status).toBe("completed");
    expect(result.orderedResults.map((task) => task.taskId)).toEqual(["done"]);
  });

  it("cancels a running snapshot and stops backing worker tasks", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    const spec = {
      mode: "parallel" as const,
      tasks: [{ id: "running" }, { id: "pending", dependsOn: ["running"] }],
    };
    store.save(createWorkflowRunSnapshot({
      runId: "run-cancel",
      status: "running",
      summary: "in progress",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["running"]),
      runningTasks: new Map([[
        "running",
        {
          taskId: "running",
          attempt: 1,
          dependencies: [],
          startedAt: 10,
          summary: "Waiting for task task_running",
          metadata: { workerTaskId: "task_running" },
        },
      ]]),
      createdAt: 1,
    }));

    const stopTask = vi.fn(async () => undefined);
    const result = await cancelPersistentWorkflow("run-cancel", {
      store,
      stopTask,
      reason: "user cancelled",
    });

    expect(stopTask).toHaveBeenCalledWith("task_running");
    expect(result.status).toBe("failed");
    expect(result.results.running).toMatchObject({ status: "killed", summary: "user cancelled" });
    expect(result.results.pending).toMatchObject({ status: "skipped", skippedReason: "user cancelled" });

    const snapshot = store.load("run-cancel");
    expect(snapshot).toMatchObject({
      status: "failed",
      summary: "user cancelled",
      pendingTaskIds: [],
      runningTaskIds: [],
    });
    expect(store.loadEvents("run-cancel")).toContainEqual(expect.objectContaining({
      type: "workflow_cancelled",
      summary: "user cancelled",
    }));
  });

  it("returns usable workflow data with safe diagnostics for corrupt files", () => {
    const dir = tempDir();
    const store = new FileWorkflowRunRepository({ dir });
    const valid = createWorkflowRunSnapshot({
      runId: "valid",
      status: "completed",
      summary: "done",
      spec: { mode: "sequential", tasks: [] },
      plan: createWorkflowPlan({ mode: "sequential", tasks: [] }),
      results: new Map(),
      running: new Set(),
      createdAt: 10,
    });
    store.save(valid);
    writeFileSync(join(dir, "broken.json"), "{broken", "utf8");
    writeFileSync(join(dir, "shape-broken.json"), JSON.stringify({
      ...valid,
      runId: "shape-broken",
      plan: { ...valid.plan, tasks: "not-an-array" },
    }), "utf8");
    writeFileSync(join(dir, "identity-mismatch.json"), JSON.stringify({
      ...valid,
      runId: "another-run",
    }), "utf8");
    appendFileSync(store.eventPathFor("valid"), [
      JSON.stringify({ version: 1, runId: "valid", type: "workflow_started", timestamp: 1 }),
      JSON.stringify({ version: 1, runId: "valid", type: "task_started", timestamp: 2, taskId: "one" }),
      "{broken",
      JSON.stringify({ version: 1, runId: "valid", type: "not_a_real_event", timestamp: 3 }),
      JSON.stringify({ version: 1, runId: "another-run", type: "workflow_finished", timestamp: 4 }),
      "",
    ].join("\n"), "utf8");

    expect(store.listWithDiagnostics()).toEqual({
      snapshots: [expect.objectContaining({ runId: "valid" })],
      diagnostics: expect.arrayContaining([
        { code: "invalid_workflow_snapshot", sourceId: "broken" },
        { code: "invalid_workflow_snapshot", sourceId: "shape-broken" },
        { code: "invalid_workflow_snapshot", sourceId: "identity-mismatch" },
      ]),
    });
    expect(store.loadEventsWithDiagnostics("valid")).toEqual({
      events: [
        expect.objectContaining({ type: "workflow_started", runId: "valid" }),
        expect.objectContaining({ type: "task_started", runId: "valid", taskId: "one" }),
      ],
      diagnostics: [
        { code: "invalid_workflow_event", sourceId: "valid:event:3" },
        { code: "invalid_workflow_event", sourceId: "valid:event:4" },
        { code: "invalid_workflow_event", sourceId: "valid:event:5" },
      ],
    });
  });

  it("does not launch pending work or overwrite an externally cancelled active run", async () => {
    const store = new FileWorkflowRunRepository({ dir: tempDir() });
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const workflow = runPersistentWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 1,
        tasks: [{ id: "first" }, { id: "second" }],
      },
      async ({ task, reportProgress }) => {
        started.push(task.id);
        if (task.id === "first") {
          reportProgress?.({ metadata: { workerTaskId: "task-first" } });
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { summary: `${task.id} done` };
      },
      { store, runId: "run-active-cancel" },
    );

    await vi.waitFor(() => {
      expect(store.load("run-active-cancel")?.runningTasks.first?.metadata).toMatchObject({
        workerTaskId: "task-first",
      });
    });
    await cancelPersistentWorkflow("run-active-cancel", {
      store,
      reason: "stop active run",
      stopTask: async () => releaseFirst?.(),
    });
    await workflow;

    expect(started).toEqual(["first"]);
    expect(store.load("run-active-cancel")).toMatchObject({
      status: "failed",
      termination: "cancelled",
      summary: "stop active run",
      runningTaskIds: [],
    });
    expect(store.loadEvents("run-active-cancel").map((event) => event.type)).not.toContain("workflow_finished");
  });
});
