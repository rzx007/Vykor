import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_BUDGET_POLICY_PRESETS,
  WORKFLOW_SPEC_TEMPLATES,
  createWorkflowNotification,
  createWorkflowPlan,
  createWorkflowSpecFromReconciliationPlan,
  createWorkflowValidationReport,
  formatWorkflowNotification,
  parseWorkflowNotification,
  runWorkflow,
  type WorkflowRunEvent,
  type WorkflowRunSnapshot,
} from "../index.js";

describe("createWorkflowPlan", () => {
  it("plans an explicit DAG in topological order", () => {
    const plan = createWorkflowPlan({
      mode: "parallel",
      tasks: [
        { id: "implement", dependsOn: ["research"] },
        { id: "research" },
        { id: "verify", dependsOn: ["implement"] },
      ],
    });

    expect(plan.executionOrder).toEqual(["research", "implement", "verify"]);
    expect(plan.dependencyMap).toEqual({
      implement: ["research"],
      research: [],
      verify: ["implement"],
    });
  });

  it("turns sequential tasks into a one-at-a-time chain", () => {
    const plan = createWorkflowPlan({
      mode: "sequential",
      tasks: [{ id: "clean" }, { id: "build" }, { id: "test" }],
      maxConcurrency: 10,
    });

    expect(plan.maxConcurrency).toBe(1);
    expect(plan.dependencyMap).toEqual({
      clean: [],
      build: ["clean"],
      test: ["build"],
    });
  });

  it("merges budget policy presets with explicit overrides", () => {
    const plan = createWorkflowPlan({
      mode: "parallel",
      budgetPolicyPreset: "safe-write",
      budgetPolicy: {
        softMaxTokensUsed: 12_000,
        conserve: { maxTurns: 1 },
      },
      tasks: [{ id: "write" }],
    });

    expect(plan.budgetPolicyPreset).toBe("safe-write");
    expect(plan.budgetPolicy).toEqual({
      ...WORKFLOW_BUDGET_POLICY_PRESETS["safe-write"],
      softMaxTokensUsed: 12_000,
      conserve: {
        ...WORKFLOW_BUDGET_POLICY_PRESETS["safe-write"].conserve,
        maxTurns: 1,
      },
    });
  });

  it("validates expanded workflow specs without running workers", () => {
    const report = createWorkflowValidationReport({
      mode: "parallel",
      tasks: [
        { id: "a", writeScope: ["packages/auth"] },
        { id: "b", writeScope: ["packages/auth/src"] },
      ],
    });

    expect(report.valid).toBe(true);
    expect(report.plan?.executionOrder).toEqual(["a", "b"]);
    expect(report.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "write-scope-overlap",
        taskIds: ["a", "b"],
      }),
    ]);

    expect(createWorkflowValidationReport({
      mode: "parallel",
      tasks: [{ id: "a", dependsOn: ["missing"] }],
    })).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ severity: "error", code: "invalid-workflow-spec" })],
    });
  });

  it("rejects duplicate ids, missing dependencies, and cycles", () => {
    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [{ id: "a" }, { id: "a" }],
      }),
    ).toThrow("Duplicate workflow task id 'a'");

    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [{ id: "a", dependsOn: ["missing"] }],
      }),
    ).toThrow("depends on missing task 'missing'");

    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [
          { id: "a", dependsOn: ["b"] },
          { id: "b", dependsOn: ["a"] },
        ],
      }),
    ).toThrow("dependency cycle");
  });
});

describe("runWorkflow", () => {
  it("runs independent tasks in parallel up to maxConcurrency", async () => {
    const started: string[] = [];
    const unblock: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;

    const workflow = runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 2,
        tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
      },
      async ({ task }) => {
        started.push(task.id);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => unblock.push(resolve));
        running -= 1;
        return { summary: `${task.id} done`, result: task.id };
      },
    );

    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    expect(maxRunning).toBe(2);

    unblock.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    unblock.shift()?.();
    unblock.shift()?.();

    const result = await workflow;
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("3/3 tasks completed");
  });

  it("passes pipeline input from the previous task", async () => {
    const seenPipelineInputs: Array<string | undefined> = [];
    const result = await runWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "implement" }, { id: "verify" }],
      },
      ({ task, pipelineInput }) => {
        seenPipelineInputs.push(pipelineInput?.taskId);
        return { summary: `${task.id} done`, result: `${task.id}-result` };
      },
    );

    expect(result.status).toBe("completed");
    expect(seenPipelineInputs).toEqual([undefined, "research", "implement"]);
    expect(result.results.verify?.result).toBe("verify-result");
  });

  it("skips dependents after a failed dependency by default", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [
          { id: "research" },
          { id: "implement", dependsOn: ["research"] },
          { id: "verify", dependsOn: ["implement"] },
          { id: "docs" },
        ],
      },
      ({ task }) => {
        if (task.id === "implement") {
          return { status: "failed", summary: "patch failed" };
        }
        return { summary: `${task.id} done` };
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.research?.status).toBe("completed");
    expect(result.results.implement?.status).toBe("failed");
    expect(result.results.verify?.status).toBe("skipped");
    expect(result.results.docs?.status).toBe("completed");
  });

  it("supports fail-fast by skipping unstarted work after the first failure", async () => {
    const result = await runWorkflow(
      {
        mode: "sequential",
        failurePolicy: "fail-fast",
        tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
      },
      ({ task }) =>
        task.id === "a"
          ? { status: "failed", summary: "boom" }
          : { summary: `${task.id} done` },
    );

    expect(result.results.a?.status).toBe("failed");
    expect(result.results.b?.status).toBe("skipped");
    expect(result.results.c?.status).toBe("skipped");
  });

  it("supports continue by running dependents after failed dependencies", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        failurePolicy: "continue",
        tasks: [
          { id: "research" },
          { id: "implement", dependsOn: ["research"] },
        ],
      },
      ({ task, dependencyResults }) => {
        if (task.id === "research") {
          return { status: "failed", summary: "inconclusive" };
        }
        expect(dependencyResults.research?.status).toBe("failed");
        return { summary: "implemented fallback" };
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.research?.status).toBe("failed");
    expect(result.results.implement?.status).toBe("completed");
  });

  it("retries failed tasks before marking them failed", async () => {
    const attempts: number[] = [];
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "flaky", retry: { maxAttempts: 3 } }],
      },
      ({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error("temporary");
        return { summary: "recovered" };
      },
    );

    expect(attempts).toEqual([1, 2, 3]);
    expect(result.results.flaky?.status).toBe("completed");
    expect(result.results.flaky?.attempts).toBe(3);
  });

  it("fails a task attempt when its timeout budget is exceeded", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "slow", timeoutMs: 1 }],
      },
      async () => {
        await new Promise(() => {
          // Intentionally never resolves; the workflow timeout should decide the attempt.
        });
        return { summary: "too late" };
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.slow).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 1,
      timedOut: true,
      error: "Task timed out after 1ms",
    }));
  });

  it("does not accept a successful result that arrives after the deadline", async () => {
    const result = await runWorkflow(
      { mode: "parallel", tasks: [{ id: "late", timeoutMs: 1 }] },
      async ({ signal }) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { summary: "late success", result: "partial work" };
      },
    );

    expect(result.results.late).toEqual(expect.objectContaining({
      status: "failed",
      timedOut: true,
      result: "partial work",
      error: "Task timed out after 1ms",
    }));
  });

  it("passes a run signal and deadline to the runner", async () => {
    let seen: { signal?: AbortSignal; deadlineAt?: number } = {};
    await runWorkflow(
      { mode: "parallel", tasks: [{ id: "work", timeoutMs: 5_000 }] },
      (context) => { seen = context; return { summary: "ok" }; },
    );

    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);
    expect(seen.deadlineAt).toBeGreaterThan(Date.now());
  });

  it("does not abort a runner that finishes before its deadline", async () => {
    let aborted = false;
    const result = await runWorkflow(
      { mode: "parallel", tasks: [{ id: "quick", timeoutMs: 5_000 }] },
      async ({ signal }) => {
        signal?.addEventListener("abort", () => { aborted = true; });
        return { summary: "done" };
      },
    );

    expect(result.results.quick?.status).toBe("completed");
    expect(aborted).toBe(false);
  });

  it("marks cleanup unconfirmed when a runner ignores the abort after its deadline", async () => {
    const result = await runWorkflow(
      { mode: "parallel", tasks: [{ id: "stubborn", timeoutMs: 1 }] },
      async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise(() => { /* never settles */ });
        return { summary: "too late" };
      },
    );

    expect(result.results.stubborn).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 1,
      timedOut: true,
      cleanupUnconfirmed: true,
    }));
  }, 15_000);

  it("emits structured workflow events", async () => {
    const events: WorkflowRunEvent[] = [];

    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "build" }],
      },
      ({ reportProgress }) => {
        reportProgress?.({ summary: "halfway" });
        return { summary: "built" };
      },
      {
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "workflow_started",
      "task_started",
      "task_progress",
      "task_progress",
      "task_finished",
      "workflow_finished",
    ]);
    expect(events.find((event) => event.type === "task_progress" && event.summary === "halfway")).toEqual(expect.objectContaining({
      taskId: "build",
      status: "running",
      summary: "halfway",
    }));
  });

  it("serializes overlapping non-isolated write scopes while allowing unrelated work", async () => {
    const started: string[] = [];
    const snapshots: WorkflowRunSnapshot[] = [];
    const events: WorkflowRunEvent[] = [];
    const unblock: Record<string, () => void> = {};
    let running = 0;
    let maxRunning = 0;

    const workflow = runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 3,
        tasks: [
          { id: "auth-a", writeScope: ["packages/auth"] },
          { id: "auth-b", writeScope: ["packages/auth/src"] },
          { id: "ui", writeScope: ["packages/ui"] },
        ],
      },
      async ({ task }) => {
        started.push(task.id);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => {
          unblock[task.id] = resolve;
        });
        running -= 1;
        return { summary: `${task.id} done` };
      },
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onEvent: (event) => events.push(event),
      },
    );

    await vi.waitFor(() => expect(started).toEqual(["auth-a", "ui"]));
    expect(maxRunning).toBe(2);
    await vi.waitFor(() => {
      const blockedSnapshot = snapshots.find((snapshot) => snapshot.blockedTaskIds.includes("auth-b"));
      expect(blockedSnapshot?.blockedTasks["auth-b"]).toEqual(expect.objectContaining({
        reason: expect.stringContaining("writeScope conflict"),
        waitingForTaskIds: ["auth-a"],
        writeScope: ["packages/auth/src"],
        conflictingWriteScope: expect.arrayContaining(["packages/auth"]),
      }));
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "task_blocked",
      taskId: "auth-b",
      blockedTask: expect.objectContaining({
        waitingForTaskIds: ["auth-a"],
      }),
    }));

    unblock["ui"]?.();
    await vi.waitFor(() => expect(started).toEqual(["auth-a", "ui"]));

    unblock["auth-a"]?.();
    await vi.waitFor(() => expect(started).toEqual(["auth-a", "ui", "auth-b"]));
    unblock["auth-b"]?.();

    const result = await workflow;
    expect(result.status).toBe("completed");
  });

  it("allows overlapping write scopes when a task is isolated or read-only", async () => {
    const started: string[] = [];
    const unblock: Array<() => void> = [];

    const workflow = runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 3,
        tasks: [
          { id: "shared", writeScope: ["packages/auth"] },
          { id: "isolated", writeScope: ["packages/auth"], isolate: true },
          { id: "readonly", writeScope: ["packages/auth"], readOnly: true },
        ],
      },
      async ({ task }) => {
        started.push(task.id);
        await new Promise<void>((resolve) => unblock.push(resolve));
        return { summary: `${task.id} done` };
      },
    );

    await vi.waitFor(() => expect(started).toEqual(["shared", "isolated", "readonly"]));
    unblock.forEach((resolve) => resolve());

    const result = await workflow;
    expect(result.status).toBe("completed");
  });

  it("marks completed overlapping write scopes as needing reconciliation", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 1,
        tasks: [
          { id: "auth-a", writeScope: ["packages/auth"] },
          { id: "auth-b", writeScope: ["packages/auth/src"] },
          { id: "docs", readOnly: true, writeScope: ["packages/auth"] },
        ],
      },
      ({ task }) => ({ summary: `${task.id} done` }),
    );

    expect(result.status).toBe("completed");
    expect(result.needsReconciliation).toBe(true);
    expect(result.reconciliationIssues).toEqual([
      expect.objectContaining({
        issueId: "reconcile-auth-a-auth-b",
        type: "write-scope-overlap",
        taskIds: ["auth-a", "auth-b"],
        writeScope: ["packages/auth", "packages/auth/src"],
      }),
    ]);

    const notification = createWorkflowNotification(result);
    expect(notification.needsReconciliation).toBe(true);
    expect(notification.tasks.find((task) => task.taskId === "auth-a")?.reconciliationIssueIds).toEqual(["reconcile-auth-a-auth-b"]);
    expect(notification.tasks.find((task) => task.taskId === "docs")?.reconciliationIssueIds).toBeUndefined();
  });

  it("distinguishes actual changed-file overlap from declared write-scope overlap", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 1,
        tasks: [
          { id: "auth-a", writeScope: ["packages/auth"] },
          { id: "auth-b", writeScope: ["packages/auth/src"] },
        ],
      },
      ({ task }) => ({
        summary: `${task.id} done`,
        metadata: {
          diff: {
            changedFiles: ["packages/auth/src/index.ts"],
            files: [{
              path: "packages/auth/src/index.ts",
              status: task.id === "auth-a" ? "modified" : "added",
              insertions: task.id === "auth-a" ? 2 : 5,
              deletions: task.id === "auth-a" ? 1 : 0,
            }],
          },
        },
      }),
    );

    expect(result.reconciliationIssues).toEqual([
      expect.objectContaining({
        issueId: "reconcile-actual-auth-a-auth-b",
        type: "changed-file-overlap",
        severity: "actual-conflict",
        changedFiles: ["packages/auth/src/index.ts"],
      }),
    ]);

    const notification = createWorkflowNotification(result);
    expect(notification.reconciliationSummary).toMatchObject({
      totalIssues: 1,
      actualConflicts: 1,
      declaredScopeOverlaps: 0,
      files: [{
        path: "packages/auth/src/index.ts",
        issueIds: ["reconcile-actual-auth-a-auth-b"],
        taskIds: ["auth-a", "auth-b"],
        statuses: { "auth-a": "modified", "auth-b": "added" },
        insertions: 7,
        deletions: 1,
      }],
      tasks: [
        {
          taskId: "auth-a",
          issueIds: ["reconcile-actual-auth-a-auth-b"],
          changedFiles: ["packages/auth/src/index.ts"],
          insertions: 2,
          deletions: 1,
        },
        {
          taskId: "auth-b",
          issueIds: ["reconcile-actual-auth-a-auth-b"],
          changedFiles: ["packages/auth/src/index.ts"],
          insertions: 5,
          deletions: 0,
        },
      ],
    });
    expect(notification.reconciliationPlan).toMatchObject({
      needed: true,
      summary: "1 reconciliation follow-up action(s) available",
      actions: [{
        actionId: "followup-reconcile-actual-auth-a-auth-b",
        issueIds: ["reconcile-actual-auth-a-auth-b"],
        taskId: "reconcile-reconcile-actual-auth-a-auth-b",
        dependsOn: ["auth-a", "auth-b"],
        writeScope: ["packages/auth/src/index.ts"],
      }],
    });
    expect(notification.reconciliationPlan.actions[0]?.prompt).toContain("Affected tasks: auth-a, auth-b.");
    expect(createWorkflowSpecFromReconciliationPlan(notification.reconciliationPlan)).toMatchObject({
      mode: "parallel",
      maxConcurrency: 1,
      failurePolicy: "fail-fast",
      budgetPolicyPreset: "safe-write",
      tasks: [
        {
          id: "reconcile-reconcile-actual-auth-a-auth-b",
          isolate: true,
          writeScope: ["packages/auth/src/index.ts"],
        },
        {
          id: "verify-reconciliation",
          readOnly: true,
          dependsOn: ["reconcile-reconcile-actual-auth-a-auth-b"],
        },
      ],
    });
  });

  it("exposes built-in workflow spec templates", () => {
    expect(WORKFLOW_SPEC_TEMPLATES["research-implement-verify"]).toMatchObject({
      name: "research-implement-verify",
      version: 1,
      spec: {
        mode: "pipeline",
        budgetPolicyPreset: "safe-write",
        tasks: [
          { id: "research" },
          { id: "implement" },
          { id: "verify" },
        ],
      },
    });
  });

  it("aggregates budget usage from task progress metadata", async () => {
    const snapshots: WorkflowRunSnapshot[] = [];
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "build" }],
      },
      ({ reportProgress }) => {
        reportProgress?.({
          summary: "budget update",
          metadata: {
            budget: {
              tokensUsed: 120,
              tokenBudget: 500,
              timeUsedMs: 250,
              timeBudgetMs: 1_000,
            },
          },
        });
        return { summary: "built" };
      },
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    );

    expect(result.results.build?.budget).toEqual({
      tokensUsed: 120,
      tokenBudget: 500,
      timeUsedMs: 250,
      timeBudgetMs: 1_000,
    });
    expect(result.budget).toMatchObject({
      tokensUsed: 120,
      tokenBudget: 500,
      timeUsedMs: 250,
      timeBudgetMs: 1_000,
    });
    expect(snapshots.some((snapshot) => snapshot.budget.tokensUsed === 120)).toBe(true);
  });

  it("stops scheduling new work after budget policy is exceeded", async () => {
    const events: WorkflowRunEvent[] = [];
    const result = await runWorkflow(
      {
        mode: "pipeline",
        budgetPolicy: { maxTokensUsed: 100 },
        tasks: [{ id: "research" }, { id: "implement" }],
      },
      ({ task }) => ({
        summary: `${task.id} done`,
        metadata: { budget: { tokensUsed: 120 } },
      }),
      {
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.research?.status).toBe("completed");
    expect(result.results.implement).toEqual(expect.objectContaining({
      status: "skipped",
      skippedReason: "Skipped because workflow token budget exceeded (120/100)",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "workflow_budget_exceeded",
      summary: "Skipped because workflow token budget exceeded (120/100)",
    }));
  });

  it("serializes and conserves later tasks after a soft budget policy is reached", async () => {
    const started: string[] = [];
    const budgetModes: Array<string | undefined> = [];
    const conservePolicies: Array<unknown> = [];
    const unblock: Record<string, () => void> = {};
    const events: WorkflowRunEvent[] = [];

    const workflow = runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 2,
        budgetPolicy: {
          softMaxTokensUsed: 100,
          onSoftLimit: "serialize-and-conserve",
          conserve: { promptHint: "small steps", permissionMode: "plan", maxTurns: 2 },
        },
        tasks: [
          { id: "first" },
          { id: "second", dependsOn: ["first"] },
          { id: "third", dependsOn: ["first"] },
        ],
      },
      async ({ task, budgetMode, budgetConserve }) => {
        started.push(task.id);
        budgetModes.push(budgetMode);
        conservePolicies.push(budgetConserve);
        if (task.id === "first") {
          return { summary: "first done", metadata: { budget: { tokensUsed: 120 } } };
        }
        await new Promise<void>((resolve) => {
          unblock[task.id] = resolve;
        });
        return { summary: `${task.id} done` };
      },
      { onEvent: (event) => events.push(event) },
    );

    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    expect(budgetModes).toEqual(["normal", "conserve"]);
    expect(conservePolicies[1]).toEqual({ promptHint: "small steps", permissionMode: "plan", maxTurns: 2 });
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        type: "workflow_budget_conserving",
        summary: "Workflow token soft budget reached (120/100); applying serialize-and-conserve",
      }));
    });
    expect(started).toEqual(["first", "second"]);

    unblock["second"]?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    expect(budgetModes).toEqual(["normal", "conserve", "conserve"]);
    unblock["third"]?.();

    const result = await workflow;
    expect(result.status).toBe("completed");
  });
});

describe("workflow notification envelope", () => {
  it("formats and parses structured workflow results", async () => {
    const result = await runWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "verify" }],
      },
      ({ task }) => ({
        summary: `${task.id} <done>`,
        result: `result for ${task.id}\nwith </workflow-notification> text`,
        metadata: { task: task.id },
      }),
    );

    const notification = createWorkflowNotification(result);
    expect(notification).toMatchObject({
      status: "completed",
      summary: "2/2 tasks completed",
      mode: "pipeline",
      totalTasks: 2,
      completedTasks: 2,
      failedTasks: 0,
    });

    const text = formatWorkflowNotification(result);
    expect(text).toContain("<workflow-notification>");
    expect(text).toContain("<payload>");
    expect(text).not.toContain("result for research\nwith </workflow-notification> text");

    const parsed = parseWorkflowNotification(text);
    expect(parsed).toEqual(notification);
    expect(parsed?.tasks[0]?.result).toContain("</workflow-notification>");
  });

  it("returns undefined for malformed workflow notifications", () => {
    expect(parseWorkflowNotification("nope")).toBeUndefined();
    expect(parseWorkflowNotification("<workflow-notification><payload>{}</payload></workflow-notification>")).toBeUndefined();
  });
});
