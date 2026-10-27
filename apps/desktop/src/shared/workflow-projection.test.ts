import { describe, expect, it } from "vitest"
import type { JobReadResult } from "@rzx/client"
import { projectWorkflowRun } from "./workflow-projection"

function read(details: Record<string, unknown> = {}): JobReadResult {
  return {
    text: "",
    cursor: 0,
    truncated: false,
    snapshot: {
      id: "w1",
      kind: "workflow",
      target: { kind: "workflow", jobId: "w1" },
      ownerSession: "main",
      label: "登录修复",
      status: "running",
      cwd: "/repo",
      startedAt: 1,
      updatedAt: 2,
      capabilities: { read: true, wait: true, send: false, cancel: true },
    },
    details: {
      plan: {
        mode: "parallel",
        maxConcurrency: 2,
        tasks: [{ id: "a", description: "接口" }, { id: "b", dependsOn: ["a"] }, { id: "c" }],
        dependencyMap: { a: [], b: ["a"], c: [] },
      },
      runningTasks: {
        a: { taskId: "a", summary: "检查测试", metadata: { workerTaskId: "worker-a" } },
      },
      blockedTasks: {
        c: { waitingForTaskIds: ["a"], reason: "write conflict", conflictingWriteScope: ["src"] },
      },
      ...details,
    },
  }
}

describe("workflow projection", () => {
  it("does not wait for an already failed upstream when the policy permits continuing", () => {
    const value = read({
      failurePolicy: "continue",
      results: { a: { status: "failed" } },
      runningTasks: {},
      blockedTasks: {},
    })
    expect(projectWorkflowRun(value).tasks[1].waitReason).toBe("capacity")
  })
  it("reports a worker stop error as unconfirmed cleanup", () => {
    const value = read({
      results: { a: { status: "killed", metadata: { stopError: "worker still active" } } },
    })
    expect(projectWorkflowRun(value).tasks[0]).toMatchObject({
      cleanupUnconfirmed: true,
      error: "worker still active",
    })
  })
  it("uses the running job rather than a settled tool receipt, distinguishing dependency and write waits", () => {
    const run = projectWorkflowRun(read())
    expect(run.status).toBe("running")
    expect(run.tasks.map((task) => [task.id, task.status, task.waitReason])).toEqual([
      ["a", "running", undefined],
      ["b", "pending", "dependency"],
      ["c", "pending", "write_conflict"],
    ])
    expect(run.tasks[0].workerTaskId).toBe("worker-a")
    expect(run.tasks[2].waitingForTaskIds).toEqual(["a"])
  })

  it("keeps cancellation, skips and reconciliation separate from success", () => {
    const value = read({
      termination: "cancelled",
      needsReconciliation: true,
      results: {
        a: { status: "failed", error: "test failed", attempts: 2 },
        b: { status: "skipped", skippedReason: "dependency failed" },
      },
    })
    value.snapshot.status = "killed"
    const run = projectWorkflowRun(value)
    expect(run.status).toBe("killed")
    expect(run.needsReconciliation).toBe(true)
    expect(run.tasks[0]).toMatchObject({ status: "failed", error: "test failed", attempts: 2 })
    expect(run.tasks[1]).toMatchObject({ status: "skipped", summary: "dependency failed" })
  })

  it("marks absent or malformed details unavailable and does not invent task results", () => {
    const value = read()
    value.details = { plan: { tasks: "broken" } }
    expect(projectWorkflowRun(value)).toMatchObject({ detailsAvailable: false, tasks: [] })
  })

  it("preserves unknown node state in a terminal run and reads timeout flags from metadata", () => {
    const value = read({
      runningTasks: {},
      blockedTasks: {},
      results: { a: { status: "failed", metadata: { timedOut: true, cleanupUnconfirmed: true } } },
    })
    value.snapshot.status = "failed"
    expect(projectWorkflowRun(value).tasks.map((t) => t.status)).toEqual([
      "failed",
      "unknown",
      "unknown",
    ])
    expect(projectWorkflowRun(value).tasks[0]).toMatchObject({
      timedOut: true,
      cleanupUnconfirmed: true,
    })
  })
})
