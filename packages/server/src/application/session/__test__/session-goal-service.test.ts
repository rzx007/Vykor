import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@openharness/services";
import { SessionGoalService } from "../session-goal-service.js";
import { SessionRunEngine } from "../session-run-engine.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function harness(
  execute?: (store: SessionStore, runId: string, signal: AbortSignal) => Promise<void>,
  waitVerifier?: {
    check: () => { state: "running"; checkedAt: number } | { state: "completed" };
  },
) {
  const directory = mkdtempSync(join(tmpdir(), "ohs-goal-lifecycle-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const events = {
    checkpoint: () => store.listEvents().at(-1)?.seq ?? 0,
    publishSince: vi.fn(),
  };
  let service: SessionGoalService;
  const engine = new SessionRunEngine({
    store,
    agentPool: { configured: true } as any,
    events,
    settleGoalRun: (sessionId, runId) => service.settleRun(sessionId, runId),
    runExecutor: {
      execute: async ({ runId }, context) => {
        store.updateRun(runId, { status: "running" });
        if (execute) await execute(store, runId, context.signal);
        else store.updateRun(runId, { status: "completed" });
      },
    },
  });
  service = new SessionGoalService({
    store,
    runEngine: engine,
    events,
    sessions: { withSessionOperation: async (_id, work) => work() },
    waitVerifier,
  });
  return { store, engine, service };
}

function assessment(store: SessionStore, runId: string, value: Record<string, unknown>, status: "completed" | "failed" = "completed") {
  const run = store.getRun(runId)!;
  store.updateRun(runId, {
    status,
    ...(status === "failed" ? { error: "verification failed" } : {}),
    metadata: {
      goalAssessment: {
        goalId: run.metadata.goalId,
        revision: run.metadata.goalRevision,
        runId,
        decision: "continue",
        progress: "推进目标",
        progressAssessment: {
          kind: "no_progress",
          summary: "尚未取得可验证进展",
          blockerKey: "no-evidence",
        },
        evidence: [],
        evidenceRefs: [],
        nextStep: "执行下一项检查",
        ...value,
      },
    },
  });
}

describe("SessionGoalService durable lifecycle", () => {
  it("rejects plugin capability items before creating a Goal, Input, or Run", async () => {
    const { service, store } = harness();

    await expect(service.create("s1", {
      requestId: "plugin-goal-create",
      objective: "use plugin",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.openharness.quality",
        displayName: "Quality",
      }],
    })).rejects.toThrow("session_goal_plugin_capability_unsupported");

    expect(store.getCurrentGoal("s1")).toBeUndefined();
    expect(store.getInput("plugin-goal-create")).toBeUndefined();
    expect(store.getGoalRequest("plugin-goal-create")).toBeUndefined();
    expect(store.listRuns("s1")).toEqual([]);
  });

  it("rejects plugin capability items before updating a Goal", async () => {
    const { service, store, engine } = harness();
    const created = await service.create("s1", {
      requestId: "ordinary-goal-create",
      objective: "ordinary goal",
    });
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    const beforeUpdate = store.getGoal(created.id)!;

    await expect(service.update("s1", created.id, {
      requestId: "plugin-goal-update",
      expectedRevision: beforeUpdate.revision,
      objective: "use plugin",
      items: [{
        type: "capability",
        kind: "plugin_agent",
        pluginId: "dev.openharness.quality",
        agentId: "dev.openharness.quality:reviewer",
        displayName: "Reviewer",
      }],
    })).rejects.toThrow("session_goal_plugin_capability_unsupported");

    expect(store.getGoal(created.id)).toMatchObject({
      objective: "ordinary goal",
      revision: beforeUpdate.revision,
    });
    expect(store.getInput("plugin-goal-update")).toBeUndefined();
    expect(store.getGoalRequest("plugin-goal-update")).toBeUndefined();
  });

  it("keeps a pause request pending until cleanup finishes and shares concurrent retries", async () => {
    let release!: () => void;
    const cleanupGate = new Promise<void>((done) => {
      release = done;
    });
    let activeSignal: AbortSignal | undefined;
    const { service, store, engine } = harness(async (store, runId, signal) => {
      activeSignal = signal;
      await cleanupGate;
      store.updateRun(runId, {
        status: signal.aborted ? "interrupted" : "completed",
      });
    });
    const created = await service.create("s1", {
      requestId: "pause-source",
      objective: "停止目标",
    });
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const command = {
      requestId: "pause-once",
      expectedRevision: created.revision,
      action: "pause" as const,
    };
    const first = service.action("s1", created.id, command);
    const second = service.action("s1", created.id, command);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
    expect(store.getGoalRequest(command.requestId)?.status).toBe("pending");
    expect(store.getGoal(created.id)?.currentRunId).toBeDefined();
    release();
    const stopped = await first;
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(stopped.status).toBe("paused");
    expect(stopped.currentRunId).toBeUndefined();
    expect(store.getGoalRequest(command.requestId)?.status).toBe("completed");
    expect(await service.action("s1", created.id, command)).toEqual(stopped);
  });

  it("automatically completes after a continuation with real checks from the current run", async () => {
    let turns = 0;
    const { service, store, engine } = harness(async (store, runId) => {
      const message = store.createMessage({
        sessionId: "s1",
        role: "assistant",
        runId,
      });
      const part = store.upsertMessagePart({
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "completed",
        toolName: "Bash",
        input: { command: "run-check" },
        output: { exitCode: 0, checked: ++turns },
      });
      assessment(store, runId, {
        decision: turns === 2 ? "complete" : "continue",
        evidence: ["实际检查通过"],
        evidenceRefs: [{ messagePartId: part.id, criterion: "相关检查通过" }],
        ...(turns === 2
          ? {
              requirements: [
                {
                  requirement: "通过两项实际检查",
                  source: "目标正文",
                  status: "satisfied",
                  evidenceRefs: [{ messagePartId: part.id, criterion: "相关检查通过" }],
                },
              ],
              remainingWork: [],
            }
          : {}),
      });
    });
    const goal = await service.create("s1", {
      requestId: "verified",
      objective: "通过两项实际检查",
      maxAutoTurns: 1,
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("completed"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.listRuns("s1")).toHaveLength(2);
    expect(store.getGoal(goal.id)?.autoTurnsUsed).toBe(1);
  });

  it("lets a queued user run assess the goal before any automatic continuation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const executed: string[] = [];
    const { service, store, engine } = harness(async (store, runId) => {
      executed.push(runId);
      if (executed.length === 1) {
        await gate;
        assessment(store, runId, {});
      } else
        assessment(store, runId, {
          decision: "waiting_user",
          question: "采用用户刚提出的选项吗？",
        });
    });
    const goal = await service.create("s1", {
      requestId: "priority",
      objective: "继续目标",
    });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    const user = await engine.admitPromptAndMaybeRun("s1", {
      id: "user-priority",
      items: [{ type: "text", text: "先回答这个问题" }],
    });
    release();
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("waiting_user"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(executed).toEqual([store.findRunByInput("priority")!.id, user.run!.id]);
    expect(store.getRun(user.run!.id)?.metadata.goalRunKind).toBe("user");
    expect(store.getGoal(goal.id)?.autoTurnsUsed).toBe(0);
    expect(store.getGoal(goal.id)?.wait).toMatchObject({
      question: "采用用户刚提出的选项吗？",
    });
  });

  it("pauses at the turn budget and rejects approval bypass", async () => {
    const { service, store, engine } = harness(async (store, runId) => assessment(store, runId, {}));
    const goal = await service.create("s1", {
      requestId: "budget",
      objective: "有限续跑",
      maxAutoTurns: 1,
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("paused"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    const paused = store.getGoal(goal.id)!;
    expect(paused.autoTurnsUsed).toBe(1);
    await expect(
      service.action("s1", goal.id, {
        requestId: "no-budget",
        action: "resume",
        expectedRevision: paused.revision,
      }),
    ).rejects.toThrow("增加");
    const permission = store.createPermissionRequest({
      sessionId: "s1",
      toolName: "Bash",
      payload: {},
    });
    const waiting = store.updateGoal(goal.id, {
      expectedRevision: paused.revision,
      status: "waiting_user",
      wait: { kind: "approval", permissionRequestId: permission.id },
    });
    await expect(
      service.action("s1", goal.id, {
        requestId: "no-approval",
        action: "resume",
        expectedRevision: waiting.revision,
        additionalAutoTurns: 2,
      }),
    ).rejects.toThrow("批准");
    expect(store.getGoal(goal.id)?.status).toBe("waiting_user");
  });

  it("rolls back the goal and input when attachment admission fails, then permits the same request to retry", async () => {
    const { service, store } = harness();
    const input = {
      requestId: "bad-attachment",
      objective: "修复并验证",
      attachments: [{ assetId: "missing", intent: "context" as const }],
    };
    await expect(service.create("s1", input)).rejects.toThrow();
    expect(store.getCurrentGoal("s1")).toBeUndefined();
    expect(store.getInput(input.requestId)).toBeUndefined();
    expect(store.listRuns("s1")).toHaveLength(0);
    expect(store.getGoalRequest(input.requestId)?.goalId).toBeUndefined();
    await expect(service.create("s1", input)).rejects.toThrow();
    expect(store.listRuns("s1")).toHaveLength(0);
  });

  it("replays committed admission after a dispatch failure without creating a second goal, input or run", async () => {
    const { service, store, engine } = harness();
    const dispatch = vi.spyOn(engine, "dispatchPersistedRun");
    dispatch.mockImplementationOnce(() => {
      throw new Error("dispatch unavailable");
    });
    const input = { requestId: "create-once", objective: "完成目标" };
    await expect(service.create("s1", input)).rejects.toThrow("dispatch unavailable");
    expect(store.listRuns("s1")).toHaveLength(1);
    const goalId = store.getCurrentGoal("s1")!.id;
    const goal = await service.create("s1", input);
    expect(goal.id).toBe(goalId);
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.listRuns("s1")).toHaveLength(1);
    expect(store.getGoalRequest(input.requestId)?.status).toBe("completed");
    expect(await service.create("s1", input)).toEqual(goal);
    await expect(service.create("s1", { ...input, objective: "不同目标" })).rejects.toMatchObject({ status: 409 });
  });

  it("settles only completed runs, counts automatic turns on start, and blocks after three rounds without real evidence", async () => {
    const { service, store, engine } = harness(async (store, runId) => assessment(store, runId, { evidence: ["模型说有进展"] }));
    const goal = await service.create("s1", {
      requestId: "three-rounds",
      objective: "完成并验证",
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("blocked"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.getGoal(goal.id)).toMatchObject({
      autoTurnsUsed: 2,
      noProgressCount: 3,
    });
    expect(store.getGoal(goal.id)?.currentRunId).toBeUndefined();
    expect(store.listRuns("s1")).toHaveLength(3);
    const last = store.listRuns("s1").at(-1)!;
    await service.settleRun("s1", last.id);
    expect(store.listRuns("s1")).toHaveLength(3);
  });

  it("does not block until the same blocker repeats for three goal turns", async () => {
    let turns = 0;
    const blockers = ["missing-a", "missing-b", "missing-b", "missing-b"];
    const { service, store, engine } = harness(async (store, runId) => {
      const blockerKey = blockers[turns++]!;
      assessment(store, runId, {
        decision: "blocked",
        progressAssessment: {
          kind: "no_progress",
          summary: blockerKey,
          blockerKey,
        },
        reason: blockerKey,
      });
    });
    const goal = await service.create("s1", {
      requestId: "blocker-audit",
      objective: "等待同一阻塞三轮",
      maxAutoTurns: 5,
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("blocked"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.listRuns("s1")).toHaveLength(4);
    expect(store.getGoal(goal.id)).toMatchObject({
      noProgressCount: 3,
      blockerKey: "missing-b",
    });
  });

  it("blocks only after three consecutive identical blockerKey results", async () => {
    let turns = 0;
    const blockers = ["missing-a", "missing-a", "missing-a"];
    const { service, store, engine } = harness(async (store, runId) => {
      const blockerKey = blockers[turns++]!;
      assessment(store, runId, {
        decision: "blocked",
        progressAssessment: {
          kind: "no_progress",
          summary: `no progress: ${blockerKey}`,
          blockerKey,
        },
        reason: blockerKey,
      });
    });
    const goal = await service.create("s1", {
      requestId: "blocker-consecutive",
      objective: "连续同一 blockerKey 阻塞三轮",
      maxAutoTurns: 5,
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("blocked"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.listRuns("s1")).toHaveLength(3);
    expect(store.getGoal(goal.id)).toMatchObject({
      noProgressCount: 3,
      blockerKey: "missing-a",
      status: "blocked",
    });
  });

  it("waits on a verified handle without spending an automatic turn, then resumes once", async () => {
    vi.useFakeTimers();
    try {
      let check: "running" | "completed" = "running";
      let turns = 0;
      const { service, store, engine } = harness(
        async (store, runId) => {
          turns += 1;
          if (turns === 1)
            assessment(store, runId, {
              progressAssessment: { kind: "waiting", summary: "构建仍在运行" },
              wait: {
                kind: "external",
                handleId: "build-run",
                deadlineAt: Date.now() + 60_000,
              },
            });
          else
            assessment(store, runId, {
              decision: "waiting_user",
              progressAssessment: { kind: "waiting", summary: "等待验收" },
              question: "请验收",
            });
        },
        {
          check: () => (check === "running" ? { state: "running", checkedAt: Date.now() } : { state: "completed" }),
        },
      );
      const goal = await service.create("s1", {
        requestId: "verified-wait",
        objective: "等待构建后检查",
      });
      await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
      expect(store.getGoal(goal.id)).toMatchObject({
        status: "active",
        wait: { kind: "external", handleId: "build-run" },
        autoTurnsUsed: 0,
      });
      check = "completed";
      await vi.advanceTimersByTimeAsync(1_000);
      await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
      expect(store.getGoal(goal.id)).toMatchObject({
        status: "waiting_user",
        autoTurnsUsed: 1,
      });
      expect(turns).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not complete a failed run even if it submitted complete", async () => {
    const { service, store, engine } = harness(async (store, runId) => {
      assessment(store, runId, { decision: "complete" }, "failed");
    });
    const goal = await service.create("s1", {
      requestId: "failed-run",
      objective: "验证目标",
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("paused"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.getGoal(goal.id)?.reason).toBe("verification failed");
  });

  it("continues instead of completing while audited work remains", async () => {
    let turns = 0;
    const { service, store, engine } = harness(async (store, runId) => {
      turns += 1;
      if (turns === 1) {
        assessment(store, runId, {
          decision: "complete",
          requirements: [
            {
              requirement: "补充文档",
              source: "目标正文",
              status: "incomplete",
              evidenceRefs: [],
            },
          ],
          remainingWork: ["补充文档"],
          nextStep: "补充文档",
        });
      } else
        assessment(store, runId, {
          decision: "waiting_user",
          question: "请检查文档",
        });
    });
    const goal = await service.create("s1", {
      requestId: "partial",
      objective: "实现并补充文档",
      maxAutoTurns: 1,
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("waiting_user"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(store.listRuns("s1")).toHaveLength(2);
  });

  it("requires the matching question to confirm subjective completion and replays confirmation once", async () => {
    const { service, store, engine } = harness(async (store, runId) =>
      assessment(store, runId, {
        decision: "complete",
        requirements: [
          {
            requirement: "页面观感舒服",
            source: "目标正文",
            status: "needs_user",
            evidenceRefs: [],
          },
        ],
        remainingWork: [],
      }),
    );
    const created = await service.create("s1", {
      requestId: "subjective",
      objective: "让页面更舒服",
    });
    await vi.waitFor(() => expect(store.getGoal(created.id)?.status).toBe("waiting_user"));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    const goal = store.getGoal(created.id)!;
    await expect(
      service.action("s1", goal.id, {
        requestId: "bad-confirm",
        expectedRevision: goal.revision,
        action: "confirm",
        questionId: "other",
      }),
    ).rejects.toThrow();
    const input = {
      requestId: "confirm",
      expectedRevision: goal.revision,
      action: "confirm" as const,
      questionId: goal.wait?.kind === "user" ? goal.wait.questionId : "",
    };
    const completed = await service.action("s1", goal.id, input);
    expect(completed.status).toBe("completed");
    expect(await service.action("s1", goal.id, input)).toEqual(completed);
    expect(store.getGoal(goal.id)?.revision).toBe(completed.revision);
  });

  it("waits for goal cleanup during edits and preserves ordinary queued user work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let first = true;
    const executed: string[] = [];
    const { service, store, engine } = harness(async (store, runId, signal) => {
      executed.push(runId);
      if (first) {
        first = false;
        await gate;
        store.updateRun(runId, {
          status: signal.aborted ? "interrupted" : "completed",
        });
      } else
        assessment(store, runId, {
          decision: "waiting_user",
          question: "确认结果",
        });
    });
    const goal = await service.create("s1", {
      requestId: "editing",
      objective: "旧目标",
    });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    const ordinary = await engine.admitPromptAndMaybeRun("s1", {
      id: "ordinary",
      items: [{ type: "text", text: "普通问题" }],
    });
    const edit = service.update("s1", goal.id, {
      requestId: "edit-once",
      expectedRevision: goal.revision,
      objective: "新目标",
    });
    await vi.waitFor(() => expect(store.getGoal(goal.id)?.status).toBe("paused"));
    expect(store.getGoal(goal.id)?.objective).toBe("旧目标");
    expect(store.getRun(ordinary.run!.id)?.status).toBe("pending");
    release();
    const updated = await edit;
    expect(updated.objective).toBe("新目标");
    await vi.waitFor(() => expect(store.listRuns("s1").every((run) => run.status !== "pending" && run.status !== "running")).toBe(true));
    await engine.waitForRuns(store.listRuns("s1").map((run) => run.id));
    expect(executed).toContain(ordinary.run!.id);
    expect(store.getRun(ordinary.run!.id)?.status).toBe("completed");
    expect(
      await service.update("s1", goal.id, {
        requestId: "edit-once",
        expectedRevision: goal.revision,
        objective: "新目标",
      }),
    ).toEqual(updated);
  });
});
