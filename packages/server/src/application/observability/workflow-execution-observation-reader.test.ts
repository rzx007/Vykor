import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowBlockedTask,
  type WorkflowRunEvent,
  type WorkflowRunSnapshot,
  type WorkflowRunningTask,
  type WorkflowTaskRunResult,
} from "@vykor/coordinator";
import { describe, expect, it } from "vitest";

import {
  readWorkflowExecutionObservations,
  type WorkflowObservationSource,
} from "./workflow-execution-observation-reader.js";

function event(
  runId: string,
  type: WorkflowRunEvent["type"],
  timestamp: number,
): WorkflowRunEvent {
  return { version: 1, runId, type, timestamp };
}

function buildSnapshot(input: {
  runId: string;
  mode?: "sequential" | "parallel" | "pipeline";
  taskIds: string[];
  ownerRun?: string;
  results?: WorkflowTaskRunResult[];
  runningTasks?: WorkflowRunningTask[];
  blockedTasks?: WorkflowBlockedTask[];
  maxConcurrency?: number;
}): WorkflowRunSnapshot {
  const spec = {
    mode: input.mode ?? "parallel",
    tasks: input.taskIds.map((id) => ({ id })),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
  };
  return createWorkflowRunSnapshot({
    runId: input.runId,
    ...(input.ownerRun ? { ownerRun: input.ownerRun } : {}),
    status: "running",
    summary: input.runId,
    spec,
    plan: createWorkflowPlan(spec),
    results: new Map((input.results ?? []).map((result) => [result.taskId, result])),
    running: new Set((input.runningTasks ?? []).map((task) => task.taskId)),
    runningTasks: new Map((input.runningTasks ?? []).map((task) => [task.taskId, task])),
    blockedTasks: new Map((input.blockedTasks ?? []).map((task) => [task.taskId, task])),
    createdAt: 50,
  });
}

function source(
  snapshots: WorkflowRunSnapshot[],
  eventsByRun: Record<string, WorkflowRunEvent[]>,
  diagnosticsByRun: Record<string, Array<{ code: "invalid_workflow_event"; sourceId: string }>> = {},
): WorkflowObservationSource {
  return {
    listWithDiagnostics: () => ({ snapshots, diagnostics: [] }),
    loadEventsWithDiagnostics: (runId) => ({
      events: eventsByRun[runId] ?? [],
      diagnostics: diagnosticsByRun[runId] ?? [],
    }),
  };
}

describe("readWorkflowExecutionObservations", () => {
  it("projects every plan task exactly once in current-state priority order", () => {
    const snapshot = buildSnapshot({
      runId: "wf-1",
      ownerRun: "root-run",
      taskIds: ["done", "running", "blocked", "pending"],
      results: [{
        taskId: "done",
        status: "completed",
        summary: "done",
        attempts: 1,
        dependencies: [],
        startedAt: 110,
        finishedAt: 150,
        metadata: { workerTaskId: "child-task" },
      }],
      runningTasks: [{ taskId: "running", attempt: 1, dependencies: [], startedAt: 160, summary: "running" }],
      blockedTasks: [{ taskId: "blocked", reason: "waiting", waitingForTaskIds: [] }],
    });

    const result = readWorkflowExecutionObservations(
      source([snapshot], {
        "wf-1": [event("wf-1", "workflow_started", 100), event("wf-1", "workflow_finished", 200)],
      }),
      new Map([["child-task", ["agent-run:child-run"]]]),
    );

    expect(result.records.filter((row) => row.executionKind === "workflow_task")).toEqual([
      expect.objectContaining({ workflowTaskId: "done", outcome: "completed" }),
      expect.objectContaining({ workflowTaskId: "running", outcome: "running" }),
      expect.objectContaining({ workflowTaskId: "blocked", outcome: "blocked" }),
      expect.objectContaining({ workflowTaskId: "pending", outcome: "pending" }),
    ]);
    expect(result.records.find((row) => row.executionKind === "workflow_run")).toMatchObject({
      executionId: "workflow:wf-1",
      parentExecutionId: "agent-run:root-run",
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
    });
    expect(result.records.find((row) => row.workflowTaskId === "done")?.backingExecutionIds)
      .toEqual(["agent-run:child-run"]);
  });

  it("marks a retried task budget partial without a cumulative flag", () => {
    const snapshot = buildSnapshot({
      runId: "wf-2",
      taskIds: ["retry"],
      results: [{
        taskId: "retry",
        status: "completed",
        summary: "retry",
        attempts: 2,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
        budget: { tokensUsed: 42 },
        metadata: { workerTaskId: "retry-worker" },
      }],
    });

    const result = readWorkflowExecutionObservations(
      source([snapshot], {
        "wf-2": [event("wf-2", "workflow_started", 10), event("wf-2", "workflow_finished", 20)],
      }),
      new Map([["retry-worker", ["agent-run:retry-worker"]]]),
    );

    const retry = result.records.find((row) => row.workflowTaskId === "retry");
    expect(retry?.usage).toMatchObject({ totalTokens: 42, completeness: "partial" });
    expect(retry?.usage.inputTokens).toBeUndefined();
    expect(retry?.completeness).toBe("partial");
  });

  it("marks a cumulative task budget complete", () => {
    const snapshot = buildSnapshot({
      runId: "wf-6",
      taskIds: ["one"],
      results: [{
        taskId: "one",
        status: "completed",
        summary: "one",
        attempts: 2,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
        budget: { tokensUsed: 7 },
        metadata: { budgetCumulativeAcrossAttempts: true },
      }],
    });

    const result = readWorkflowExecutionObservations(
      source([snapshot], { "wf-6": [] }),
      new Map(),
    );

    expect(result.records.find((row) => row.workflowTaskId === "one")?.usage.completeness)
      .toBe("complete");
  });

  it("omits workflow duration when any event is corrupt", () => {
    const snapshot = buildSnapshot({
      runId: "wf-3",
      taskIds: ["one"],
      results: [{
        taskId: "one",
        status: "completed",
        summary: "one",
        attempts: 1,
        dependencies: [],
        startedAt: 10,
        finishedAt: 20,
      }],
    });

    const result = readWorkflowExecutionObservations(
      source(
        [snapshot],
        { "wf-3": [event("wf-3", "workflow_started", 100), event("wf-3", "workflow_finished", 200)] },
        { "wf-3": [{ code: "invalid_workflow_event", sourceId: "wf-3:event:3" }] },
      ),
      new Map(),
    );

    const run = result.records.find((row) => row.executionKind === "workflow_run");
    expect(run).toMatchObject({ executionId: "workflow:wf-3", completeness: "partial" });
    expect(run?.durationMs).toBeUndefined();
    expect(run?.finishedAt).toBeUndefined();
    expect(result.warnings).toContainEqual({
      code: "invalid_workflow_event",
      sourceId: "wf-3:event:3",
    });
  });

  it("classifies a timed out task with a structured failure kind", () => {
    const snapshot = buildSnapshot({
      runId: "wf-timeout",
      taskIds: ["slow"],
      results: [{
        taskId: "slow",
        status: "failed",
        summary: "timeout",
        attempts: 1,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
        timedOut: true,
      }],
    });
    const result = readWorkflowExecutionObservations(source([snapshot], { "wf-timeout": [] }), new Map());
    expect(result.records.find((row) => row.workflowTaskId === "slow")).toMatchObject({
      outcome: "timed_out",
      failureKind: "timeout",
    });
  });

  it("keeps exactly one record when a task appears in two containers", () => {
    const snapshot = buildSnapshot({
      runId: "wf-4",
      taskIds: ["dup"],
      results: [{
        taskId: "dup",
        status: "completed",
        summary: "dup",
        attempts: 1,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
      }],
    });
    snapshot.pendingTaskIds = ["dup"];

    const result = readWorkflowExecutionObservations(source([snapshot], { "wf-4": [] }), new Map());

    const tasks = result.records.filter((row) => row.executionKind === "workflow_task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ workflowTaskId: "dup", outcome: "completed" });
  });

  it("does not fabricate a configured concurrency when the snapshot is unbounded", () => {
    const snapshot = buildSnapshot({
      runId: "wf-5",
      taskIds: ["one"],
      results: [{
        taskId: "one",
        status: "completed",
        summary: "one",
        attempts: 1,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
      }],
    });
    expect(snapshot.plan.maxConcurrency).toBe("unbounded");

    const result = readWorkflowExecutionObservations(source([snapshot], { "wf-5": [] }), new Map());
    const run = result.records.find((row) => row.executionKind === "workflow_run");
    expect(run?.configuredConcurrency).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("unbounded");
  });
});
