import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { createGoalRunContribution } from "../../../goals/goal-run-contribution.js";
import { GoalModelAttemptService } from "../../../goals/goal-model-attempt-service.js";
import type { GoalUpdateInput, SessionGoal } from "@vykor/domain-contracts/goals";
import { SessionGoalService } from "../session-goal-service.js";
import type { AdmitPromptInput } from "../../execution/run-admission-service.js";
import type { GoalWaitCheck } from "../goal-wait-verifier.js";
import { GoalWaitVerifier } from "../goal-wait-verifier.js";
import type { InputPluginScope } from "../../plugins/session-plugin-selection.js";

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
  const pluginCapabilities = { admit: vi.fn(async () => ({} as { pluginId?: string })),
    captureScope: vi.fn(async (): Promise<InputPluginScope> => ({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] })) };
  const service = new SessionGoalService({
    transaction: store, sessions: store.sessions, runs: store.runs, conversations: store.conversations,
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

function recordResult(h: ReturnType<typeof harness>, text: string, tool?: {
  name?: string; input?: Record<string, unknown>; output?: unknown; isError?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const run = h.run();
  h.store.runs.updateRun(run.id, { metadata: { terminalOutput: text } });
  const message = h.store.conversations.createMessage({ sessionId: "s1", runId: run.id, role: "assistant" });
  const raw = tool?.output ?? { content: [{ type: "text", text: "unchanged" }] };
  const body = raw && typeof raw === "object" && "content" in raw ? raw
    : { content: [{ type: "text", text: JSON.stringify(raw) }] };
  if (tool) h.store.conversations.upsertMessagePart({
    sessionId: "s1", messageId: message.id, type: "tool", status: "completed",
    toolUseId: `tool-${run.id}`, toolName: tool.name ?? "Read", input: tool.input ?? { file_path: "result.txt" },
    output: { ...body, toolUseId: `tool-${run.id}`, toolName: tool.name ?? "Read",
      toolAttemptId: `attempt-${run.id}`, resultRef: { id: `result-${run.id}`, toolName: tool.name ?? "Read", totalChars: 9 },
      executionState: "completed", isError: tool.isError ?? false },
    isError: tool.isError ?? false, metadata: tool.metadata ?? {},
  });
  h.store.conversations.upsertMessagePart({ sessionId: "s1", messageId: message.id,
    type: "text", status: "completed", text });
}

describe("Goal automatic continuation progress", () => {
  it("pauses after three repeated replies instead of admitting another automatic Run", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 4; turn++) {
      recordResult(h, "M2 仍未完成，是否继续？");
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
    expect(h.current().currentRunId).toBeUndefined();
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(4);
    await h.service.settleRun("s1", h.store.runs.listRuns("s1").at(-1)!.id);
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(4);
  });

  it("stops empty successful turns even when there is no final reply to compare", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) await h.finish();
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(3);
  });

  it("does not count rewritten summaries or repeated tool results as new execution", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 4; turn++) {
      recordResult(h, `检查总结 ${turn}`, { input: turn % 2 ? { encoding: "utf8", file_path: "result.txt" }
        : { file_path: "result.txt", encoding: "utf8" } });
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
  });

  it("stops repeated failed tools despite changing error details and summaries", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) {
      recordResult(h, `重试说明 ${turn}`, { isError: true, output: { error: `request-${turn} failed` } });
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
  });

  it("allows fresh tool results even when the final summary is unchanged", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 8; turn++) {
      recordResult(h, "继续处理下一项", { output: { content: [{ type: "text", text: `result ${turn}` }] } });
      await h.finish();
    }
    expect(h.current().status).toBe("active");
  });

  it("allows successive text-only deliverables", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 8; turn++) {
      recordResult(h, `第 ${turn + 1} 节：新的稿件正文。`);
      await h.finish();
    }
    expect(h.current().status).toBe("active");
  });

  it("stops an alternating cycle of already-seen tool results", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 5; turn++) {
      recordResult(h, `总结 ${turn}`, { output: { value: turn % 2 ? "B" : "A" } });
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(5);
  });

  it("stops a repeated cycle spanning more rounds than the stalled-turn threshold", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 7; turn++) {
      recordResult(h, `总结 ${turn}`, { output: { value: ["A", "B", "C", "D"][turn % 4] } });
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(7);
  });

  it("resets the stalled streak when a new result arrives", async () => {
    const h = harness(); await h.create();
    for (const value of ["A", "A", "A", "B", "B", "B"]) {
      recordResult(h, "总结不变", { output: { value } });
      await h.finish();
    }
    expect(h.current().status).toBe("active");
    recordResult(h, "总结不变", { output: { value: "B" } });
    await h.finish();
    expect(h.current().stopReason?.code).toBe("no_progress");
  });

  it.each([false, true])("ignores changing results from an uncommitted model attempt (superseded=%s)", async superseded => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 4; turn++) {
      recordResult(h, "最终交付不变", { output: { value: turn }, metadata: {
        modelGeneration: { generationId: `g-${turn}`, attempt: 1, committed: superseded, superseded },
      } });
      await h.finish();
    }
    expect(h.current().stopReason?.code).toBe("no_progress");
  });

  it("starts a new progress segment when the objective changes", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) { recordResult(h, "相同结果"); await h.finish(); }
    await h.service.update("s1", h.current().id, {
      requestId: "new-objective", expectedRevision: h.current().revision, objective: "先完成另一个模块",
    });
    recordResult(h, "相同结果"); await h.finish();
    expect(h.current()).toMatchObject({ status: "active", objectiveVersion: 2 });
  });

  it("starts a new segment after supplemental user work, even if its metadata contains an old counter", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) { recordResult(h, "相同结果"); await h.finish(); }
    const goal = h.current(), automatic = h.run();
    h.store.runs.updateRun(automatic.id, { status: "interrupted" });
    const user = h.store.runs.createRun({ sessionId: "s1", metadata: {
      goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion, goalRunKind: "user",
      goalProgress: automatic.metadata.goalProgress,
    } });
    h.store.goals.startGoalRun(goal.id, goal.objectiveVersion, user.id, false);
    h.store.runs.updateRun(user.id, { status: "running" });
    recordResult(h, "相同结果"); await h.finish();
    expect(h.current().status).toBe("active");
  });

  it("does not let GoalRead counters keep repeated replies running", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 4; turn++) {
      recordResult(h, "仍需继续", { name: "GoalRead", output: { autoTurnsUsed: turn, knownTokens: turn * 100 } });
      await h.finish();
    }
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "no_progress" } });
  });

  it("persists the automatic Run's progress window and resets it after explicit resume", async () => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) { recordResult(h, "相同结果"); await h.finish(); }
    const reopened = new SessionStore({ path: join(h.directory, "sessions.db") });
    try {
      expect(reopened.runs.getRun(h.run().id)?.metadata.goalProgress).toMatchObject({ noProgressTurns: 2 });
    } finally { reopened.close(); }
    recordResult(h, "相同结果"); await h.finish();
    expect(h.current().status).toBe("paused");
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "resume-progress", expectedRevision: h.current().revision });
    recordResult(h, "相同结果"); await h.finish();
    expect(h.current().status).toBe("active");
  });

  it.each(["completed", "question", "wait"] as const)("applies explicit %s instead of the repetition guard", async action => {
    const h = harness(); await h.create();
    for (let turn = 0; turn < 3; turn++) { recordResult(h, "相同结果"); await h.finish(); }
    recordResult(h, "相同结果");
    await h.finish(action === "completed" ? { status: "completed", reason: "已验证" }
      : action === "question" ? { question: "需要选择哪个版本？" }
      : { wait: { targetRunId: "external-run", deadlineAt: Date.now() + 30_000 } });
    expect(h.current().status).toBe(action === "completed" ? "completed" : action === "question" ? "waiting_user" : "active");
    expect(h.current().stopReason?.code).not.toBe("no_progress");
  });
});

describe("SessionGoalService simple lifecycle", () => {
  it.each(["partial", "blocked", "waiting"] as const)("pauses a completed GoalUpdate that contradicts %s delivery", async status => {
    const h = harness(); await h.create();
    const runId = h.run().id;
    h.store.runs.updateRun(runId, { metadata: { delivery: {
      status, summary: "work remains", data: {}, validation: "schema_valid", verification: "passed",
    } } });
    await h.finish({ status: "completed", reason: "all done" });
    expect(h.current()).toMatchObject({ status: "paused", stopReason: { code: "run_error", runId } });
    expect(h.current().reason).toContain(status);
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(1);
  });

  it.each(["done", "waiting"] as const)("keeps %s delivery independent from Goal state without an explicit update", async status => {
    const h = harness(); await h.create();
    h.store.runs.updateRun(h.run().id, { metadata: { delivery: {
      status, summary: "report", data: {}, validation: "schema_valid", verification: "passed",
    } } });
    await h.finish();
    expect(h.current().status).toBe("active");
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(2);
  });

  it.each([false, true])("blocks resume after a settlement write fails (terminal recovery also failed: %s)", async recoveryFailed => {
    const h = harness();
    await h.create({ tokenBudget: 100 });
    const run = h.run();
    const gate = new GoalModelAttemptService({ store: h.store, events: { checkpoint: () => 0, publishSince() {} } });
    const attempt = { scope: { agentId: "s1", sessionId: "s1", runId: run.id, inputId: run.inputId!,
      traceId: "trace", cwd: process.cwd(), signal: new AbortController().signal },
      generationId: "generation", attempt: 1, model: "m", purpose: "generation" as const };
    await gate.beforeDispatch(attempt);
    vi.spyOn(h.store.goals, "recordGoalModelAttempt").mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(gate.settle({ ...attempt, status: "completed", usageStatus: "complete",
      usage: { inputTokens: 8, outputTokens: 2 } })).rejects.toThrow("write failed");
    if (recoveryFailed) vi.spyOn(h.store.goals, "reconcileGoalModelAttempts").mockImplementationOnce(() => { throw new Error("recovery write failed"); });
    await h.finish(undefined, "failed");
    if (!recoveryFailed) expect(h.current().usage).toMatchObject({ incomplete: true, unknownAttempts: 1, inFlightAttempts: 0 });
    const runsBefore = h.store.runs.listGoalRuns(h.current().id).length;
    await expect(h.service.action("s1", h.current().id, { action: "resume", requestId: "retry",
      expectedRevision: h.current().revision })).rejects.toThrow(/用量不完整/);
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(runsBefore);
  });

  it("queues one resume while user work is pending and dispatches once only after all user work ends", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "补充后继续" });
    h.userWork(true);
    const request = { action: "resume" as const, requestId: "queued", expectedRevision: h.current().revision };
    const queued = await h.service.action("s1", h.current().id, request);
    expect(queued.queuedResume).toEqual({ requestId: "queued" });
    await h.service.action("s1", queued.id, request);
    await h.service.action("s1", queued.id, { ...request, requestId: "duplicate", expectedRevision: h.current().revision });
    expect(h.store.runs.listGoalRuns(queued.id).filter(run => run.metadata.goalRunKind === "resume")).toHaveLength(0);
    const first = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(first.id, { status: "completed" });
    await h.service.settleRun("s1", first.id);
    expect(h.service.get("s1")?.queuedResume).toBeDefined();
    expect(h.current().status).toBe("paused");
    h.userWork(false);
    const last = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(last.id, { status: "completed" });
    await Promise.all([h.service.settleRun("s1", last.id), h.service.settleRun("s1", last.id)]);
    expect(h.current().status).toBe("active");
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.store.runs.listGoalRuns(queued.id).filter(run => run.metadata.goalRunKind === "resume")).toHaveLength(1);
    const lateCancel = await h.service.action("s1", queued.id, {
      action: "cancel_resume", requestId: "late-cancel", expectedRevision: queued.revision,
    });
    expect(lateCancel.status).toBe("active");
    expect(h.run().status).toBe("running");
  });
  it("allows a fresh resume after a queued resume fails to dispatch", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "补充后继续" });
    h.userWork(true);
    const request = { action: "resume" as const, requestId: "queued-dispatch", expectedRevision: h.current().revision };
    await h.service.action("s1", h.current().id, request);
    h.failDispatch(true);
    h.userWork(false);
    const user = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(user.id, { status: "completed" });
    await h.service.settleRun("s1", user.id);
    expect(h.current().status).toBe("paused");
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    h.failDispatch(false);
    const resumed = await h.service.action("s1", h.current().id, {
      action: "resume", requestId: "fresh-resume", expectedRevision: h.current().revision,
    });
    expect(resumed.status).toBe("active");
    const resumes = h.store.runs.listGoalRuns(resumed.id).filter(run => run.metadata.goalRunKind === "resume");
    expect(resumes.filter(run => run.status === "pending")).toHaveLength(0);
    expect(resumes.filter(run => run.status === "running")).toHaveLength(1);
    expect(h.store.goals.getGoalRequest(request.requestId)?.status).toBe("completed");
    await h.service.action("s1", resumed.id, request);
    expect(h.store.runs.listGoalRuns(resumed.id).filter(run => run.metadata.goalRunKind === "resume")).toHaveLength(2);
  });
  it.each(["cancel_resume", "pause", "cancel"] as const)("revokes a queued resume on %s", async action => {
    const h = harness(); await h.create(); await h.finish({ status: "blocked", reason: "等补充" });
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision });
    await h.service.action("s1", h.current().id, { action, requestId: "cancel-queue", expectedRevision: h.current().revision });
    h.userWork(false);
    const user = h.store.runs.createRun({ sessionId: "s1" });
    const nextUser = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(nextUser.id, { status: "completed" });
    await h.service.settleRun("s1", nextUser.id);
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.current().status).toBe(action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "blocked");
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(1);
  });
  it("restores a queued question answer after failed dispatch and resends it without adding quota twice", async () => {
    const h = harness(); await h.create({ maxAutoTurns: 1 }); await h.finish({ question: "检查哪个模块？" });
    const wait = h.current().wait;
    if (wait?.kind !== "user") throw new Error("expected question");
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued-answer",
      expectedRevision: h.current().revision, questionId: wait.questionId, objectiveVersion: 1,
      response: "协议模块", additionalAutoTurns: 2 });
    h.failDispatch(true); h.userWork(false);
    await h.service.settleQueuedResume("s1");
    expect(h.current()).toMatchObject({ status: "waiting_user", maxAutoTurns: 3,
      wait: { ...wait, response: "协议模块" } });
    h.failDispatch(false);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "answer-again",
      expectedRevision: h.current().revision, questionId: wait.questionId, objectiveVersion: 1, response: "协议模块" });
    expect(h.current()).toMatchObject({ status: "active", maxAutoTurns: 3 });
    expect(h.store.conversations.getInput(h.run().inputId!)?.content).toBe("协议模块");
    expect(h.store.runs.listGoalRuns(h.current().id).filter(run => run.status === "running")).toHaveLength(1);
  });
  it("waits for a supplemental user Run that is already associated with this Goal", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "等补充" });
    const user = h.store.runs.createRun({ sessionId: "s1", metadata: {
      goalId: h.current().id, goalObjectiveVersion: 1, goalRunKind: "user",
    } });
    h.store.runs.updateRun(user.id, { status: "running" });
    h.userWork(true);
    const queued = await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued-user-run", expectedRevision: h.current().revision });
    expect(queued.queuedResume).toBeDefined();
    h.store.runs.updateRun(user.id, { status: "completed" });
    h.userWork(false);
    await h.service.settleRun("s1", user.id);
    expect(h.current().status).toBe("active");
  });
  it("does not resume an edited goal or silently continue after a failed supplemental message", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "等补充" });
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision });
    const user = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(user.id, { status: "failed", error: "补充处理失败" });
    h.userWork(false);
    await h.service.settleRun("s1", user.id);
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.current().reason).toContain("补充消息");
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued-again", expectedRevision: h.current().revision });
    await h.service.update("s1", h.current().id, { requestId: "edit-queued", objective: "新的目标", expectedRevision: h.current().revision });
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    h.userWork(false);
    const nextUser = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(nextUser.id, { status: "completed" });
    await h.service.settleRun("s1", nextUser.id);
    expect(h.current().status).toBe("paused");
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(1);
  });
  it("preserves question answers and charges additional quota only when the queued resume actually starts", async () => {
    const h = harness(); await h.create({ maxAutoTurns: 1 }); await h.finish({ question: "哪个模块？" });
    const wait = h.current().wait;
    if (wait?.kind !== "user") throw new Error("expected question");
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "answer-queued",
      expectedRevision: h.current().revision, questionId: wait.questionId, objectiveVersion: wait.objectiveVersion,
      response: "协议模块", additionalAutoTurns: 2 });
    expect(h.current().maxAutoTurns).toBe(1);
    h.userWork(false);
    const user = h.store.runs.createRun({ sessionId: "s1" });
    h.store.runs.updateRun(user.id, { status: "completed" });
    await h.service.settleRun("s1", user.id);
    expect(h.current().maxAutoTurns).toBe(3);
    expect(h.store.conversations.getInput(h.run().inputId!)?.items).toContainEqual({ type: "text", text: "协议模块" });
  });
  it("cancels queued requests on daemon recovery instead of leaving an inert queued badge", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "等补充" });
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision });
    h.service.recoverExternalWaits();
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.current().reason).toContain("重启");
    expect(h.store.goals.getGoalRequest("queued")?.status).toBe("completed");
  });
  it("revokes queued resumes on budget edits and on input preparation failure without a Run", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "补充后继续" });
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision });
    h.userWork(false);
    await h.service.settleQueuedResume("s1", true);
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.current().status).toBe("paused");
    expect(h.current().reason).toContain("补充消息");
    h.userWork(true);
    await h.service.action("s1", h.current().id, { action: "resume", requestId: "queued-budget", expectedRevision: h.current().revision });
    await h.service.action("s1", h.current().id, { action: "budget", tokenBudget: 1, requestId: "budget-edit", expectedRevision: h.current().revision });
    h.userWork(false);
    await h.service.settleQueuedResume("s1");
    expect(h.service.get("s1")?.queuedResume).toBeUndefined();
    expect(h.store.runs.listGoalRuns(h.current().id)).toHaveLength(1);
  });
  it("captures a new goal's plugin scope and keeps the resolved upper bound for continuation and resume", async () => {
    const h = harness();
    const candidates = ["P", "Q"].map(pluginId => ({ pluginId, displayName: pluginId, description: pluginId, version: "1", behaviorDigest: `${pluginId}-digest` }));
    const initial: InputPluginScope = { scopeVersion: 2, source: "auto", pluginIds: ["P", "Q"], candidates };
    h.pluginCapabilities.captureScope.mockResolvedValue(initial);
    await h.create();
    const first = h.run();
    expect(first.metadata.pluginScope).toEqual(initial);
    expect(h.store.conversations.getInput(first.inputId!)!.metadata.pluginScope).toEqual(initial);
    const resolved = { scopeVersion: 2 as const, source: "auto" as const, pluginIds: ["Q"], candidates: [candidates[1]!] };
    h.store.runs.updateRun(first.id, { metadata: { pluginSelection: { ...resolved, status: "resolved", pluginId: null, reason: "matched" } } });
    h.pluginCapabilities.captureScope.mockResolvedValue({ ...initial, pluginIds: ["foreign"], candidates: [{ ...candidates[0]!, pluginId: "foreign" }] });
    await h.finish();
    expect(h.run().metadata.pluginScope).toEqual(resolved);
    await h.finish({ status: "paused", reason: "check later" });
    await h.service.action("s1", h.current().id, { requestId: "resume-scope", action: "resume", expectedRevision: h.current().revision });
    expect(h.run().metadata.pluginScope).toEqual(resolved);
    expect(h.pluginCapabilities.captureScope).toHaveBeenCalledTimes(1);
  });

  it("persists a newly captured scope when editing a paused goal, then uses it after resume", async () => {
    const h = harness(); await h.create(); await h.finish({ status: "paused", reason: "stop" });
    const candidates = [{ pluginId: "Q", displayName: "Q", description: "Q", version: "2", behaviorDigest: "new-digest" }];
    const scope: InputPluginScope = { scopeVersion: 2, source: "auto", pluginIds: ["Q"], candidates };
    h.pluginCapabilities.captureScope.mockResolvedValue(scope);
    await h.service.update("s1", h.current().id, { requestId: "edit-scope", expectedRevision: h.current().revision, objective: "new objective" });
    h.pluginCapabilities.captureScope.mockResolvedValue({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] });
    await h.service.action("s1", h.current().id, { requestId: "resume-edit", action: "resume", expectedRevision: h.current().revision });
    expect(h.run().metadata.pluginScope).toEqual(scope);
    expect(h.pluginCapabilities.captureScope).toHaveBeenCalledTimes(2);
  });

  it("does not discover plugins when resuming a goal whose original run had no saved plugin scope", async () => {
    const h = harness(); await h.create();
    const first = h.run();
    await h.finish({ status: "paused", reason: "stop" });
    h.store.runs.updateRun(first.id, { metadata: { pluginScope: undefined, pluginSelectionPolicy: undefined } });
    h.pluginCapabilities.captureScope.mockResolvedValue({ scopeVersion: 2, source: "auto", pluginIds: ["new"], candidates: [
      { pluginId: "new", displayName: "New", description: "New", version: "1" },
    ] });
    await h.service.action("s1", h.current().id, { requestId: "resume-legacy", action: "resume", expectedRevision: h.current().revision });
    expect(h.run().metadata.pluginScope).toEqual({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] });
    expect(h.pluginCapabilities.captureScope).toHaveBeenCalledTimes(1);
  });
  it("continues a legacy automatic singleton using its saved identity without discovering other plugins", async () => {
    const h = harness(); await h.create();
    const first = h.run();
    h.store.runs.updateRun(first.id, { metadata: { pluginScope: undefined,
      pluginSelection: { status: "resolved", source: "auto", pluginId: "P", version: "1", behaviorDigest: "P-digest", reason: "matched" },
    } });
    await h.finish();
    const scope = { scopeVersion: 2, source: "auto", pluginIds: ["P"], candidates: [
      { pluginId: "P", displayName: "P", description: "", version: "1", behaviorDigest: "P-digest" },
    ] };
    expect(h.run().metadata.pluginScope).toEqual(scope);
    await h.finish({ status: "paused", reason: "stop" });
    await h.service.action("s1", h.current().id, { requestId: "resume-legacy-plugin", action: "resume", expectedRevision: h.current().revision });
    expect(h.run().metadata.pluginScope).toEqual(scope);
    expect(h.pluginCapabilities.captureScope).toHaveBeenCalledTimes(1);
  });
  it("stops legacy plugin continuation when the saved source identity is incomplete", async () => {
    const h = harness(); await h.create();
    h.store.runs.updateRun(h.run().id, { metadata: { pluginScope: undefined,
      pluginSelection: { status: "resolved", source: "auto", pluginId: "P", version: "1", reason: "matched" },
    } });
    await h.finish();
    expect(h.current().status).toBe("paused");
    expect(h.current().reason).toMatch(/插件范围|plugin scope/);
    expect(h.admission.dispatchPersistedRun).toHaveBeenCalledTimes(1);
  });
  it("retains an empty legacy resolved selection instead of reviving its earlier candidate scope", async () => {
    const h = harness();
    h.pluginCapabilities.captureScope.mockResolvedValue({ scopeVersion: 2, source: "auto", pluginIds: ["P"], candidates: [
      { pluginId: "P", displayName: "P", description: "P", version: "1", behaviorDigest: "digest" },
    ] });
    await h.create();
    h.store.runs.updateRun(h.run().id, { metadata: { pluginSelection: { status: "resolved", source: "auto", pluginId: null, reason: "no_match" } } });
    await h.finish();
    expect(h.run().metadata.pluginScope).toEqual({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] });
  });
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
    expect(h.pluginCapabilities.captureScope).not.toHaveBeenCalled();
  });
  it("does not create a goal until its asynchronous plugin scope has been captured", async () => {
    const h = harness();
    let release!: (scope: InputPluginScope) => void;
    h.pluginCapabilities.captureScope.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = h.create();
    await vi.waitFor(() => expect(h.pluginCapabilities.captureScope).toHaveBeenCalledOnce());
    expect(h.store.goals.getCurrentGoal("s1")).toBeUndefined();
    release({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] });
    await pending;
    expect(h.run().metadata.pluginScope).toEqual({ scopeVersion: 2, source: "none", pluginIds: [], candidates: [] });
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
