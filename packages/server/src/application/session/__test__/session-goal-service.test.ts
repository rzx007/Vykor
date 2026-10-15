import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { createGoalRunContribution } from "@vykor/agent-runtime";
import type { GoalUpdateInput, SessionGoal } from "@vykor/protocol";
import { SessionGoalService } from "../session-goal-service.js";
import type { AdmitPromptInput } from "../run-admission-service.js";
import type { GoalWaitCheck } from "../goal-wait-verifier.js";
import { GoalWaitVerifier } from "../goal-wait-verifier.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function harness(realWaitVerifier = false) {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-simple-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
  let hasUserWork = false;
  let dispatchError = false;
  let waitResult: GoalWaitCheck = { state: "running" };
  const events = { checkpoint: () => store.conversations.latestEventSeq(), publishSince: vi.fn() };
  const admission = {
    persistGoalRun: vi.fn((sessionId: string, input: AdmitPromptInput) => store.conversationTransactions.admitPromptWithRun({
      prompt: { id: input.id, sessionId, delivery: "queue", items: input.items!, attachments: input.attachments ?? [], metadata: input.metadata },
      run: { metadata: input.runMetadata },
    })),
    persistGoalInput: vi.fn((sessionId: string, input: AdmitPromptInput) => store.conversationTransactions.admitPrompt({
      id: input.id, sessionId, delivery: "queue", items: input.items!, attachments: input.attachments ?? [], metadata: input.metadata,
    })),
    dispatchPersistedRun: vi.fn((runId: string) => {
      if (dispatchError) throw new Error("dispatch unavailable");
      const run = store.runs.getRun(runId)!;
      if (!store.goals.startGoalRun(String(run.metadata.goalId), Number(run.metadata.goalObjectiveVersion), runId, run.metadata.goalRunKind === "continuation"))
        throw new Error("run admission refused");
      store.runs.updateRun(runId, { status: "running" });
    }),
    isRunQueuedOrRunning: (id: string) => store.runs.getRun(id)?.status === "running",
  };
  const control = {
    cancelGoalRuns: vi.fn((sessionId: string, goalId: string, reason: string) => {
      const runs = store.runs.listRuns(sessionId).filter(run => run.metadata.goalId === goalId && ["pending", "running"].includes(run.status));
      for (const run of runs) store.runs.updateRun(run.id, { status: "interrupted", error: reason });
      return runs.map(run => run.id);
    }),
    waitForRuns: vi.fn(async () => {}),
    stopGoalChildren: vi.fn(async () => {}),
    hasUserWork: () => hasUserWork,
  };
  const pluginCapabilities = { admit: vi.fn(async () => ({} as { pluginId?: string })) };
  const service = new SessionGoalService({
    transaction: store, sessions: store.sessions, runs: store.runs,
    permissions: store.permissions, goals: store.goals, events, admission, control, pluginCapabilities,
    operationRunner: { run: async (_id, work) => work() },
    waitVerifier: realWaitVerifier ? new GoalWaitVerifier({ store }) : { check: () => waitResult },
  });
  const current = () => store.goals.getCurrentGoal("s1", true)!;
  const run = () => store.runs.getRun(current().currentRunId!)!;
  const finish = async (update?: GoalUpdateInput, status: "completed" | "failed" = "completed") => {
    const goal = current(), root = run();
    if (update) await service.submitRunUpdate(goal.id, goal.objectiveVersion, root.id, update as unknown as Record<string, unknown>);
    store.runs.updateRun(root.id, { status, ...(status === "failed" ? { error: "run failed" } : {}) });
    await service.settleRun("s1", root.id);
    return root.id;
  };
  disposals.push(async () => {
    const goal = store.goals.getCurrentGoal("s1");
    if (goal && !["completed", "cancelled"].includes(goal.status)) {
      try { await service.action("s1", goal.id, { action: "cancel", requestId: "cleanup", expectedRevision: goal.revision }); } catch {}
    }
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory, service, admission, control, pluginCapabilities, current, run, finish,
    userWork: (value: boolean) => { hasUserWork = value; }, failDispatch: (value: boolean) => { dispatchError = value; },
    wait: (value: GoalWaitCheck) => { waitResult = value; },
    create: (options: { requestId?: string; objective?: string; maxAutoTurns?: number; tokenBudget?: number } = {}) =>
      service.create("s1", { requestId: "create", objective: "完成当前任务", ...options }),
  };
}

function childRun(h: ReturnType<typeof harness>, parentId: string, id = "child-run") {
  h.store.sessions.create({ id, cwd: process.cwd(), model: "m" });
  h.store.runs.createRun({ id, sessionId: id, metadata: {
    goalId: h.current().id, goalObjectiveVersion: h.current().objectiveVersion, parentRunId: parentId,
  } });
  h.store.runs.updateRun(id, { status: "running" });
  return h.store.runs.getRun(id)!;
}

describe("SessionGoalService simple lifecycle", () => {
  it("keeps the child live across a settled parent, wakes once, then automatically continues to completion", async () => {
    const h = harness(true); await h.create();
    const goal = h.current(), root = h.run();
    const child = childRun(h, root.id);
    const file = join(h.directory, "target.txt");
    writeFileSync(file, "BEFORE");
    await h.finish({ wait: { targetRunId: child.id, deadlineAt: Date.now() + 30_000 } });
    expect(h.current()).toMatchObject({ status: "active", wait: { ownerRunId: root.id, targetRunId: child.id } });
    expect(h.current().currentRunId).toBeUndefined();
    expect(() => h.service.checkRunExecution(goal.id, 1, root.id, "model")).toThrow();
    expect(() => h.service.checkRunExecution(goal.id, 1, root.id, "child")).toThrow();
    await expect(h.service.submitRunUpdate(goal.id, 1, child.id, { status: "completed", reason: "not the root" })).rejects.toThrow();
    expect(() => h.service.checkRunExecution(goal.id, 1, child.id, "model")).not.toThrow();
    expect(() => h.service.checkRunExecution(goal.id, 1, child.id, "tool", { toolName: "Write", toolAttemptId: "write-after" })).not.toThrow();
    writeFileSync(file, "AFTER");
    // The observer must not resume merely because the child has produced a result.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
    h.store.runs.updateRun(child.id, { status: "completed", finishedAt: Date.now() });
    await vi.waitFor(() => expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(h.current().wait).toBeUndefined();
    const awakened = h.run();
    expect(awakened.metadata).toMatchObject({ goalRunKind: "continuation", goalWaitSource: { targetRunId: child.id } });
    expect(readFileSync(file, "utf8")).toBe("AFTER");
    await h.service.settleRun("s1", root.id);
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(2);
    await h.finish(); // No GoalUpdate: ordinary automatic continuation after the awakened Run.
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(3);
    expect(h.run().id).not.toBe(awakened.id);
    await h.finish({ status: "completed", reason: "重新读到 AFTER，自动续跑完成" });
    expect(h.current().status).toBe("completed");
    expect(h.store.runs.listRuns("s1")).toHaveLength(3);
    expect(h.store.runs.listRuns(child.sessionId)).toHaveLength(1);
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(3);
  });

  it.each(["missing-parent", "cycle", "wrong-version", "wrong-goal", "wrong-root-session", "failed-parent", "interrupted-parent"])("rejects a child with %s ancestry", async fault => {
    const h = harness(); await h.create();
    const goal = h.current(), root = h.run();
    const child = childRun(h, root.id);
    if (fault === "missing-parent") h.store.runs.updateRun(child.id, { metadata: { parentRunId: "missing" } });
    if (fault === "cycle") h.store.runs.updateRun(child.id, { metadata: { parentRunId: child.id } });
    if (fault === "wrong-version") h.store.runs.updateRun(root.id, { metadata: { goalObjectiveVersion: 2 } });
    if (fault === "wrong-goal") h.store.runs.updateRun(root.id, { metadata: { goalId: "other-goal" } });
    if (fault === "wrong-root-session") h.store.runs.updateRun(child.id, { metadata: { parentRunId: undefined } });
    if (fault === "failed-parent") h.store.runs.updateRun(root.id, { status: "failed" });
    if (fault === "interrupted-parent") h.store.runs.updateRun(root.id, { status: "interrupted" });
    expect(() => h.service.checkRunExecution(goal.id, 1, child.id, "model")).toThrow();
  });

  it.each(["paused", "cancelled", "edited", "budget", "child-completed", "child-failed", "child-interrupted"])("still stops a waiting child after %s", async fault => {
    const h = harness(true); await h.create();
    const goal = h.current(), root = h.run();
    const child = childRun(h, root.id);
    await h.finish({ wait: { targetRunId: child.id, deadlineAt: Date.now() + 30_000 } });
    if (fault === "paused" || fault === "cancelled") await h.service.action("s1", goal.id, {
      requestId: fault, action: fault === "paused" ? "pause" : "cancel", expectedRevision: h.current().revision,
    });
    if (fault === "edited") await h.service.update("s1", goal.id, {
      requestId: "edit-waiting-goal", expectedRevision: h.current().revision, objective: "新的完整目标",
    });
    if (fault === "budget") {
      h.store.goals.updateGoal(goal.id, { expectedRevision: h.current().revision, tokenBudget: 1 });
      vi.spyOn(h.store.goals, "checkGoalBudget").mockReturnValue({ budgetClosed: true, code: "token_budget" } as any);
    }
    if (fault.startsWith("child-")) h.store.runs.updateRun(child.id, { status: fault.slice(6) as "completed" | "failed" | "interrupted" });
    expect(() => h.service.checkRunExecution(goal.id, 1, child.id, "tool")).toThrow();
  });

  it("creates a normal initial run without a preparation phase", async () => {
    const h = harness(); await h.create();
    expect(h.current()).not.toHaveProperty("phase");
    expect(h.current()).not.toHaveProperty("requirements");
    expect(h.run().metadata).toMatchObject({ goalRunKind: "initial", goalId: h.current().id });
    expect(h.run().metadata).not.toHaveProperty("goalPhase");
    expect(h.store.goals.listGoalVersions(h.current().id)).toHaveLength(1);
  });
  it("continues a normal turn without a GoalUpdate and settles it only once", async () => {
    const h = harness(); await h.create();
    const id = await h.finish();
    expect(h.current().status).toBe("active");
    expect(h.run().id).not.toBe(id);
    expect(h.current().autoTurnsUsed).toBe(1);
    await h.service.settleRun("s1", id);
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(2);
  });
  it("records completion until the run ends so the final reply can finish", async () => {
    const h = harness(); await h.create();
    const root = h.run(), goal = h.current();
    await h.service.submitRunUpdate(goal.id, 1, root.id, { status: "completed", reason: "检查全部通过" });
    expect(h.current().status).toBe("active");
    expect(h.store.runs.getRun(root.id)?.metadata.goalUpdate).toMatchObject({ status: "completed" });
    await h.finish();
    expect(h.current()).toMatchObject({ status: "completed", reason: "检查全部通过" });
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
  });
  it("connects the real GoalUpdate tool to durable Run metadata and terminal settlement", async () => {
    const h = harness(); await h.create();
    const goal = h.current(), root = h.run();
    const contribution = await createGoalRunContribution({ goalId: goal.id, objectiveVersion: 1,
      readSnapshot: () => h.service.readSnapshot(goal.id, 1, root.id),
      submitUpdate: input => h.service.submitRunUpdate(goal.id, 1, root.id, input) });
    const tool = contribution.tools!.find(item => item.definition.name === "GoalUpdate")!.definition;
    const result = await tool.execute({ status: "completed", reason: "当前结果已核对" }, {} as any);
    expect(result.isError).not.toBe(true);
    expect(h.current().status).toBe("active");
    await h.finish();
    expect(h.current().status).toBe("completed");
  });
  it("allows existing post-run maintenance only while the completed root is still bound", async () => {
    const h = harness(); await h.create();
    const goal = h.current(), root = h.run();
    h.store.runs.updateRun(root.id, { status: "completed" });
    expect(() => h.service.checkRunExecution(goal.id, 1, root.id, "maintenance")).not.toThrow();
    await h.service.settleRun("s1", root.id);
    expect(() => h.service.checkRunExecution(goal.id, 1, root.id, "maintenance")).toThrow();
  });
  it("does not complete when the run failed after recording completion", async () => {
    const h = harness(); await h.create();
    await h.finish({ status: "completed", reason: "finished" }, "failed");
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "run_error" } });
  });
  it.each(["paused", "cancelled"] as const)("a late completion cannot override %s", async status => {
    const h = harness(); await h.create();
    const goal = h.current(), runId = h.run().id;
    await h.service.submitRunUpdate(goal.id, 1, runId, { status: "completed", reason: "finished" });
    h.store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status });
    h.store.runs.updateRun(runId, { status: "completed" });
    await h.service.settleRun("s1", runId);
    expect(h.current().status).toBe(status);
  });
  it("rejects submissions after a budget stop, despite unchanged run identity", async () => {
    const h = harness(); await h.create();
    const goal = h.current(), runId = h.run().id;
    h.store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", stopReason: { code: "token_budget", at: Date.now() } });
    await expect(h.service.submitRunUpdate(goal.id, 1, runId, { status: "completed", reason: "done" })).rejects.toThrow();
    expect(h.current().stopReason?.code).toBe("token_budget");
  });
  it("rejects foreign, stale, or model-supplied identities and mixed requests", async () => {
    const h = harness(); await h.create();
    const goal = h.current(), runId = h.run().id;
    await expect(h.service.submitRunUpdate(goal.id, 2, runId, { status: "completed", reason: "done" })).rejects.toThrow();
    await expect(h.service.submitRunUpdate(goal.id, 1, "other-run", { question: "which?" })).rejects.toThrow();
    await expect(h.service.submitRunUpdate(goal.id, 1, runId, { goalId: goal.id, question: "which?" })).rejects.toThrow();
    await expect(h.service.submitRunUpdate(goal.id, 1, runId, { question: "which?", status: "completed", reason: "done" })).rejects.toThrow();
  });
  it("keeps a single control request per run and accepts identical retries", async () => {
    const h = harness(); await h.create();
    const goal = h.current(), root = h.run();
    await h.service.submitRunUpdate(goal.id, 1, root.id, { question: "选择哪一项？" });
    await expect(h.service.submitRunUpdate(goal.id, 1, root.id, { question: "选择哪一项？" })).resolves.toEqual({ recorded: true });
    await expect(h.service.submitRunUpdate(goal.id, 1, root.id, { status: "completed", reason: "done" })).rejects.toThrow("已记录");
  });
  it("creates a bound question and resumes only from the matching answer", async () => {
    const h = harness(); await h.create();
    await h.finish({ question: "选择哪一项？" });
    const goal = h.current(), wait = goal.wait!;
    expect(goal.status).toBe("waiting_user");
    if (wait.kind !== "user") throw new Error("expected user wait");
    await expect(h.service.action("s1", goal.id, { requestId: "wrong-answer", action: "resume", expectedRevision: goal.revision,
      response: "A", questionId: "wrong", objectiveVersion: 1 })).rejects.toThrow("当前版本");
    await h.service.action("s1", goal.id, { requestId: "answer", action: "resume", expectedRevision: goal.revision,
      response: "A", questionId: wait.questionId, objectiveVersion: 1 });
    expect(h.current()).toMatchObject({ status: "active" });
    expect(h.current().wait).toBeUndefined();
    expect(h.store.conversations.getInput(h.run().inputId!)?.items).toContainEqual({ type: "text", text: "A" });
  });
  it("does not silently resume a user pause with a stale answer", async () => {
    const h = harness(); await h.create();
    await h.finish({ question: "选哪项？" });
    const wait = h.current().wait!;
    const paused = await h.service.action("s1", h.current().id, { action: "pause", requestId: "pause", expectedRevision: h.current().revision });
    if (wait.kind !== "user") throw new Error("expected user wait");
    await expect(h.service.action("s1", paused.id, { requestId: "old-answer", action: "resume", expectedRevision: h.current().revision,
      questionId: wait.questionId, objectiveVersion: 1, response: "A" })).rejects.toThrow();
    expect(h.current().status).toBe("paused");
  });
  it.each(["pending", "denied", "approved"] as const)("resumes an approval wait only when its permission is approved (%s)", async status => {
    const h = harness(); await h.create();
    const permission = h.store.permissions.create({ sessionId: "s1", runId: h.run().id, toolName: "Write", payload: {} });
    await h.finish();
    expect(h.current()).toMatchObject({ status: "waiting_user", wait: { kind: "approval", permissionRequestId: permission.id } });
    if (status !== "pending") h.store.permissions.reply({ requestId: permission.id, status });
    const goal = h.current();
    const resumed = h.service.action("s1", goal.id, { action: "resume", requestId: "resume-approved", expectedRevision: goal.revision });
    if (status === "approved") {
      await resumed;
      expect(h.current().status).toBe("active");
      expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(2);
    } else {
      await expect(resumed).rejects.toThrow("批准");
      expect(h.current().status).toBe("waiting_user");
    }
  });
  it.each(["paused", "blocked"] as const)("editing preserves %s until explicit resume", async status => {
    const h = harness(); await h.create();
    await h.finish({ status, reason: "暂时停止" });
    const original = h.current();
    await h.service.update("s1", original.id, { requestId: "edit", expectedRevision: original.revision, objective: "新的完整目标" });
    expect(h.current()).toMatchObject({ status, objectiveVersion: 2, objective: "新的完整目标" });
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
    await h.service.action("s1", original.id, { requestId: "resume", action: "resume", expectedRevision: h.current().revision });
    expect(h.current().status).toBe("active");
  });
  it("editing invalidates old questions and clears old wait associations", async () => {
    const h = harness(); await h.create(); await h.finish({ question: "选择？" });
    const original = h.current(), wait = original.wait!;
    await h.service.update("s1", original.id, { requestId: "edit", expectedRevision: original.revision, objective: "新的完整目标" });
    expect(h.current()).toMatchObject({ status: "active", objectiveVersion: 2 });
    expect(h.current().wait).toBeUndefined();
    expect(h.store.goals.listGoalVersions(original.id).map(version => version.objective)).toEqual(["完成当前任务", "新的完整目标"]);
    if (wait.kind !== "user") throw new Error("expected user wait");
    await expect(h.service.action("s1", original.id, { requestId: "old", action: "resume", expectedRevision: h.current().revision,
      questionId: wait.questionId, objectiveVersion: 1, response: "A" })).rejects.toThrow();
  });
  it("an old run cannot complete the edited objective", async () => {
    const h = harness(); await h.create();
    const original = h.current(), root = h.run();
    await h.service.submitRunUpdate(original.id, 1, root.id, { status: "completed", reason: "old" });
    await h.service.update("s1", original.id, { requestId: "edit", expectedRevision: original.revision, objective: "新的目标" });
    await h.service.settleRun("s1", root.id);
    expect(h.current()).toMatchObject({ status: "active", objectiveVersion: 2, objective: "新的目标" });
  });
  it("same text editing is a no-op and duplicate create does not dispatch twice", async () => {
    const h = harness(); await h.create(); await h.create();
    const goal = h.current();
    await h.service.update("s1", goal.id, { requestId: "edit", expectedRevision: goal.revision, objective: goal.objective });
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
    expect(h.current().objectiveVersion).toBe(1);
    await expect(h.create({ objective: "different" })).rejects.toThrow();
  });
  it("honors a user-set turn limit while the default is unlimited", async () => {
    const h = harness(); await h.create({ maxAutoTurns: 1 }); await h.finish(); await h.finish();
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "auto_turn_limit" } });
  });
  it("user work takes priority over an automatic continuation", async () => {
    const h = harness(); await h.create(); h.userWork(true); await h.finish();
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
    expect(h.current().status).toBe("active");
  });
  it("replays a saved initial dispatch after a transient dispatch error", async () => {
    const h = harness(); h.failDispatch(true);
    await expect(h.create()).rejects.toThrow("dispatch unavailable");
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "run_error" } });
    h.failDispatch(false); await h.create();
    expect(h.store.runs.listRuns("s1")).toHaveLength(1);
    expect(h.current().status).toBe("active");
  });
  it("checks plugin selection before creating any goal", async () => {
    const h = harness();
    h.pluginCapabilities.admit.mockRejectedValueOnce(new Error("plugin unavailable"));
    await expect(h.create()).rejects.toThrow("plugin unavailable");
    expect(h.store.goals.getCurrentGoal("s1")).toBeUndefined();
    h.pluginCapabilities.admit.mockResolvedValueOnce({ pluginId: "plugin" });
    await h.create({ requestId: "selected" });
    expect(h.run().metadata.pluginId).toBe("plugin");
  });
  it("registers a precise task wait and resumes only once after completion", async () => {
    const h = harness(); await h.create();
    await h.finish({ wait: { targetRunId: "child-run", deadlineAt: Date.now() + 30_000 } });
    expect(h.current().wait).toMatchObject({ kind: "external", targetRunId: "child-run" });
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
    h.wait({ state: "completed" });
    await vi.waitFor(() => expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(h.current().wait).toBeUndefined();
  });
  it("rejects an invalid task wait without recording it", async () => {
    const h = harness(); await h.create(); h.wait({ state: "missing" });
    await expect(h.service.submitRunUpdate(h.current().id, 1, h.run().id,
      { wait: { targetRunId: "foreign", deadlineAt: Date.now() + 30_000 } })).rejects.toThrow("归属");
    expect(h.run().metadata.goalUpdate).toBeUndefined();
  });
  it("pauses on an external failure without restarting the task", async () => {
    const h = harness(); await h.create();
    await h.finish({ wait: { targetRunId: "child-run", deadlineAt: Date.now() + 30_000 } });
    h.wait({ state: "failed", code: "external_failed", reason: "child failed" });
    await vi.waitFor(() => expect(h.current().status).toBe("paused"), { timeout: 3000 });
    expect(h.current().stopReason?.code).toBe("external_failed");
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
  });
});
