import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowTaskRunResult,
} from "@vykor/coordinator";
import {
  createWorkflowCommand,
  createWorkflowListPayload,
  createWorkflowReconcilePayload,
  createWorkflowTemplatePayload,
  readWorkflowSpec,
} from "./workflow";

describe("workflow command", () => {
  it("registers workflow subcommands", () => {
    const cmd = createWorkflowCommand();
    expect(cmd.name()).toBe("workflow");
    expect(cmd.commands.map((sub) => sub.name()).sort()).toEqual([
      "cancel",
      "list",
      "reconcile",
      "status",
      "template",
      "validate",
    ]);
  });

  it("filters workflow run summaries", () => {
    const payload = createWorkflowListPayload([
      {
        runId: "old-run",
        status: "completed",
        summary: "done",
        mode: "parallel",
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        pendingTasks: 0,
        runningTasks: 0,
        blockedTasks: 0,
        needsReconciliation: false,
        budget: { tasks: {} },
        createdAt: 1,
        updatedAt: 2,
      },
      {
        runId: "wf-safe-1",
        status: "failed",
        summary: "needs reconcile",
        mode: "parallel",
        totalTasks: 2,
        completedTasks: 2,
        failedTasks: 0,
        pendingTasks: 0,
        runningTasks: 0,
        blockedTasks: 0,
        needsReconciliation: true,
        budget: { tasks: {} },
        budgetPolicyPreset: "safe-write",
        createdAt: 10,
        updatedAt: 20,
      },
    ], {
      status: "failed",
      runIdPrefix: "wf-",
      needsReconciliation: true,
      budgetPreset: "safe-write",
      createdAfter: "5",
      limit: "1",
    });

    expect(payload.runs.map((run) => run.runId)).toEqual(["wf-safe-1"]);
    expect(payload.filters).toMatchObject({
      statuses: ["failed"],
      runIdPrefix: "wf-",
      needsReconciliation: true,
      budgetPreset: "safe-write",
      createdAfter: 5,
      limit: 1,
    });
  });

  it("reads workflow specs from inline JSON or a file", () => {
    const inline = readWorkflowSpec({
      specJson: JSON.stringify({ mode: "parallel", tasks: [{ id: "a" }] }),
    });
    expect(inline).toEqual({ mode: "parallel", tasks: [{ id: "a" }] });

    const dir = mkdtempSync(join(tmpdir(), "oh-workflow-cli-"));
    try {
      const path = join(dir, "spec.json");
      writeFileSync(path, JSON.stringify({ mode: "pipeline", tasks: [{ id: "a" }, { id: "b" }] }));
      expect(readWorkflowSpec({ spec: path })).toEqual({
        mode: "pipeline",
        tasks: [{ id: "a" }, { id: "b" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns parameterized workflow templates", () => {
    const payload = createWorkflowTemplatePayload("research-implement-verify", {
      paramsJson: JSON.stringify({
        taskPrompts: { implement: "Only patch packages/tools" },
        writeScope: ["packages/tools"],
        budgetPreset: "fast-parallel",
      }),
    });

    expect(payload.templates).toHaveLength(1);
    expect(payload.templates[0]).toMatchObject({
      name: "research-implement-verify",
      version: 1,
      spec: {
        budgetPolicyPreset: "fast-parallel",
        tasks: [
          { id: "research", writeScope: ["packages/tools"] },
          { id: "implement", prompt: "Only patch packages/tools", writeScope: ["packages/tools"] },
          { id: "verify", readOnly: true },
        ],
      },
    });
  });

  it("creates reconciliation follow-up specs from snapshots", () => {
    const spec = {
      mode: "parallel" as const,
      tasks: [
        { id: "auth-a", writeScope: ["packages/auth"] },
        { id: "auth-b", writeScope: ["packages/auth/src"] },
      ],
    };
    const results = new Map<string, WorkflowTaskRunResult>([
      ["auth-a", completedResult("auth-a")],
      ["auth-b", completedResult("auth-b")],
    ]);
    const snapshot = createWorkflowRunSnapshot({
      runId: "wf-reconcile",
      status: "completed",
      summary: "2/2 tasks completed",
      spec,
      plan: createWorkflowPlan(spec),
      results,
      running: new Set(),
      createdAt: 1,
    });

    const payload = createWorkflowReconcilePayload(snapshot, { budgetPreset: "cheap-review" });
    expect(payload.sourceRunId).toBe("wf-reconcile");
    expect(payload.spec).toMatchObject({
      mode: "parallel",
      budgetPolicyPreset: "cheap-review",
      tasks: [
        { id: "reconcile-reconcile-auth-a-auth-b", isolate: true },
        { id: "verify-reconciliation", readOnly: true },
      ],
    });
    expect(payload.reconciliationPlan.needed).toBe(true);
  });
});

function completedResult(taskId: string): WorkflowTaskRunResult {
  return {
    taskId,
    status: "completed",
    summary: `${taskId} done`,
    attempts: 1,
    dependencies: [],
    startedAt: 1,
    finishedAt: 2,
  };
}
