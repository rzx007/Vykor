import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { SessionGoalService } from "../session-goal-service.js";
import type { GoalWaitCheck } from "../goal-wait-verifier.js";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { assembleSessionRunServices } from "../session-run-assembly.js";
import { SessionRunExecutor } from "../session-run-executor.js";
import { createRunCapabilityView } from "@vykor/agent-runtime";
import { ToolRegistry, type RunCapabilityView } from "@vykor/core";
import type { GoalRequirement, SessionGoal } from "@vykor/protocol";

const pluginId = "dev.vykor.quality";
const pluginSkill = {
  name: "review",
  path: "/plugins/quality/skills/review/SKILL.md",
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function harness(
  execute?: (store: SessionStore, runId: string, signal: AbortSignal) => Promise<void>,
  waitVerifier?: {
    check: () => GoalWaitCheck;
  },
  createView?: (pluginId?: string) => RunCapabilityView,
  options: { autoPrepare?: boolean; verification?: GoalRequirement["verification"] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-lifecycle-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m", metadata: { runtime: { model: "m" } } });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const events = {
    checkpoint: () => store.conversations.listEvents().at(-1)?.seq ?? 0,
    publishSince: vi.fn(),
  };
  let service: SessionGoalService;
  let pluginsAvailable = true;
  const executeRun = async (runId: string, signal: AbortSignal) => {
    const run = store.runs.getRun(runId)!;
    if (run.metadata.goalPhase === "preparing" && options.autoPrepare !== false) {
      const goal = store.goals.getGoal(String(run.metadata.goalId))!;
      assessment(store, runId, { decision: "ready", progressAssessment: { kind: "progress", summary: "条件明确" },
        preparedRequirements: [{ text: goal.objective, constraints: [], source: [{ kind: "input", inputId: run.inputId, quote: goal.objective }],
          verification: options.verification ?? { kind: "check", method: "运行目标检查", command: "run-check", environment: "local", expected: "通过" } }] });
    } else if (execute) await execute(store, runId, signal);
    else store.runs.updateRun(runId, { status: "completed" });
  };
  const runServices = assembleSessionRunServices({
    pendingPermissionId: (sessionId) => store.permissions.list({ sessionId, status: "pending" })[0]?.id,
    store,
    goals: store.goals,
    agentPool: { configured: true } as any,
    events,
    attachmentLimits: undefined,
    materializeSteerInput: async (_sessionId, items) => items.map((item) => item.type === "text" ? item.text : "").join(""),
    assertReady: () => {},
    settleGoalRun: (sessionId, runId) => service.settleRun(sessionId, runId),
    checkGoalExecution: (goalId, version) => service.checkExecution(goalId, version),
    runExecutor: createView ? new SessionRunExecutor({
      data: store, attachments: store.attachments, goals: store.goals, events,
      readGoalSnapshot: (goalId, version, runId) => service.readSnapshot(goalId, version, runId),
      agentPool: {
        configured: true,
        acquireSession: async () => ({
          setModel: () => {}, createRunCapabilityView: createView,
          submitMessage: (_content: unknown, options: any) => ({
            result: executeRun(options.ids.runId, options.signal),
          }),
        }),
        close: async () => {}, closeIfStale: async () => {},
      } as any,
      transcriptProjection: { finalizeRunParts: () => {}, projectAttachmentTransformations: () => {} },
      traceIdForRun: () => "goal-test", log: () => {},
    }) : {
      execute: async ({ runId }, context) => {
        store.runs.updateRun(runId, { status: "running" });
        await executeRun(runId, context.signal);
      },
    },
  });
  service = new SessionGoalService({
    transaction: store,
    sessions: store.sessions,
    runs: store.runs,
    conversations: store.conversations,
    permissions: store.permissions,
    goals: store.goals,
    admission: runServices.admission,
    control: runServices.control,
    events,
    operationRunner: { run: async (_id, work) => work() },
    waitVerifier,
    pluginCapabilities: new SessionPluginCapabilityService({
      resolveInventory: async () => ({
        plugins: new Map((pluginsAvailable ? [pluginId, "dev.vykor.research"] : []).map((id) => [id, {
          pluginId: id,
          displayName: "Quality",
          description: "",
          version: "1.0.0",
          scope: "user",
          origin: "native",
          skillNames: [pluginSkill.name],
          mcpServerIds: [],
          nativeToolEntries: [],
          agentNames: [],
        }])),
        skills: new Map([[pluginSkill.name, { pluginId, path: pluginSkill.path }]]),
        mcpServers: new Map(),
        nativeToolEntries: new Map(),
        agents: new Map(),
        diagnostics: [],
      }),
    }),
  });
  return {
    store,
    engine: runServices.engine,
    control: runServices.control,
    admission: runServices.admission,
    service,
    disablePlugins: () => { pluginsAvailable = false; },
  };
}

function assessment(store: SessionStore, runId: string, value: Record<string, unknown>, status: "completed" | "failed" = "completed") {
  const run = store.runs.getRun(runId)!;
  store.runs.updateRun(runId, {
    status,
    ...(status === "failed" ? { error: "verification failed" } : {}),
    metadata: {
      goalAssessment: {
        goalId: run.metadata.goalId,
        objectiveVersion: run.metadata.goalObjectiveVersion,
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
        ...(run.metadata.goalPhase === "executing" ? {
          requirements: store.goals.getGoal(String(run.metadata.goalId))!.requirements.map(item => ({
            requirementId: item.id, explanation: "尚需完成检查", status: "incomplete", evidenceRefs: [],
          })), progressSignals: [],
        } : {}),
        nextStep: "执行下一项检查",
        ...value,
      },
    },
  });
}

function requirementId(store: SessionStore, runId: string): string {
  return store.goals.getGoal(String(store.runs.getRun(runId)!.metadata.goalId))!.requirements[0]!.id;
}

async function drainRuns(store: SessionStore, control: { waitForRuns(ids: string[]): Promise<unknown> }): Promise<void> {
  for (let pass = 0; pass < 64; pass++) {
    const runs = store.runs.listRuns("s1");
    await control.waitForRuns(runs.map(run => run.id));
    if (store.runs.listRuns("s1").every(run => run.status !== "running" && run.status !== "pending")) return;
  }
  throw new Error("Goal Run queue did not drain");
}

function currentFixtureGoal(store: SessionStore, input: { sessionId: string; objective: string; maxAutoTurns: number; tokenBudget?: number }): SessionGoal {
  return store.goals.createGoal({ ...input, phase: "executing", requirements: [{ id: "R1", text: input.objective,
    source: [{ kind: "input", inputId: "fixture-input", quote: input.objective }], constraints: [],
    verification: { kind: "check", method: "目标检查", command: "run-check", environment: "local", expected: "通过" } }] });
}

function modelAttempt(store: SessionStore, runId: string, tokens = 1): void {
  const key = { runId, sessionId: "s1", generationId: "generation", attempt: 1 };
  expect(store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" })).toMatchObject({ allowed: true });
  store.goals.recordGoalModelAttempt({ ...key, status: "completed", usageStatus: "complete", metering: {
    knownInputTokens: tokens, knownOutputTokens: 0, completeness: "complete", inputIncludesCache: true, raw: { input: tokens, output: 0 },
  } });
}

describe("SessionGoalService durable lifecycle", () => {
  it("keeps ready paused behind ordinary user work and resumes the saved candidate without another preparation", async () => {
    let preparationCalls = 0;
    let releasePreparation!: () => void;
    let finishUser!: () => void;
    const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
    const userGate = new Promise<void>(resolve => { finishUser = resolve; });
    const h = harness(async (store, runId) => {
      const run = store.runs.getRun(runId)!;
      if (run.metadata.goalId === undefined) {
        await userGate;
        store.runs.updateRun(runId, { status: "completed" });
      } else if (run.metadata.goalPhase === "preparing") {
        preparationCalls++;
        modelAttempt(store, runId);
        await preparationGate;
        assessment(store, runId, { decision: "ready", progressAssessment: { kind: "progress", summary: "条件已明确" },
          preparedRequirements: [{ text: "完成说明", constraints: [], source: [{ kind: "input", inputId: run.inputId, quote: "完成说明" }],
            verification: { kind: "user_acceptance", question: "说明是否完整？" } }] });
      } else store.runs.updateRun(runId, { status: "completed" });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "ready-user-source", objective: "完成说明" });
    await vi.waitFor(() => expect(preparationCalls).toBe(1));
    const user = await h.admission.admitPromptAndMaybeRun("s1", { id: "ordinary-behind-preparation", items: [{ type: "text", text: "先回答另一个普通问题" }] });
    expect(h.store.runs.getRun(user.run!.id)?.status).toBe("pending");
    releasePreparation();
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "preparing", status: "paused" }));
    const saved = h.store.goals.getGoal(created.id)!;
    const episode = h.store.goals.getPreparationEpisode("ready-user-source")!;
    expect(episode).toMatchObject({ state: "ready", modelAttempts: 1 });
    expect(episode.readyRunId).toBe(episode.runId);
    expect(saved.currentRunId).toBeUndefined();
    expect(h.store.goals.getGoalVersion(created.id, 1)?.frozenAt).toBeUndefined();
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(1);
    expect(h.control.hasUserWork("s1")).toBe(true);
    finishUser();
    await h.control.waitForRuns([user.run!.id]);
    expect(h.store.runs.getRun(user.run!.id)).toMatchObject({ status: "completed" });
    expect(h.store.runs.getRun(user.run!.id)?.metadata.goalId).toBeUndefined();
    await h.service.action("s1", created.id, { requestId: "ready-after-user", expectedRevision: saved.revision, action: "resume" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "executing", status: "paused" }));
    expect(preparationCalls).toBe(1);
    expect(h.store.goals.getPreparationEpisode("ready-user-source")?.modelAttempts).toBe(1);
    expect(h.store.runs.listGoalRuns(created.id).map(run => run.metadata.goalRunKind)).toEqual(["preparation", "initial"]);
  });

  it("retains the original refine replacement authorization after a clarification answer opens a new episode", async () => {
    const h = harness(async (store, runId) => {
      const run = store.runs.getRun(runId)!;
      if (run.metadata.goalPhase !== "preparing") { store.runs.updateRun(runId, { status: "completed" }); return; }
      modelAttempt(store, runId);
      if (run.metadata.goalObjectiveVersion === 2 && run.metadata.goalEpisodeId === "authorized-refine") {
        assessment(store, runId, { decision: "waiting_user", question: "新的接口检查命令是什么？", progressAssessment: { kind: "waiting", summary: "需补充检查方法" } });
        return;
      }
      const previous = store.goals.getGoalVersion(String(run.metadata.goalId), 1)?.requirements[0];
      const replacing = run.metadata.goalObjectiveVersion === 2;
      assessment(store, runId, { decision: "ready", progressAssessment: { kind: "progress", summary: "检查方法明确" }, preparedRequirements: [{
        text: replacing ? "检查新接口" : "检查接口", constraints: [],
        ...(replacing ? { previousRequirementId: previous!.id } : {}),
        source: [{ kind: "input", inputId: run.inputId, quote: replacing ? "new-check" : "检查接口" }],
        verification: { kind: "check", method: "运行接口检查", command: replacing ? "new-check" : "old-check", environment: "local", expected: "通过" },
      }] });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "replacement-original", objective: "检查接口" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "executing", status: "paused" }));
    const originalVersion = h.store.goals.getGoalVersion(created.id, 1)!;
    const oldId = originalVersion.requirements[0]!.id;
    await h.service.update("s1", created.id, { requestId: "authorized-refine", expectedRevision: h.store.goals.getGoal(created.id)!.revision,
      objective: "改为检查新接口", changeKind: "refine", changeReason: "用户明确替换接口检查", replaceRequirementIds: [oldId] });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "preparing", status: "waiting_user" }));
    const waiting = h.store.goals.getGoal(created.id)!;
    if (waiting.wait?.kind !== "user") throw new Error("Expected a clarification question");
    const answer = { requestId: "replacement-answer", expectedRevision: waiting.revision, action: "resume" as const,
      questionId: waiting.wait.questionId, objectiveVersion: 2, response: "用 new-check，检查返回通过。" };
    const accepted = await h.service.action("s1", created.id, answer);
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "executing", objectiveVersion: 2, status: "paused" }));
    const replaced = h.store.goals.getGoalVersion(created.id, 2)!;
    expect(replaced.requestId).toBe("authorized-refine");
    expect(h.store.goals.getGoalRequest("replacement-answer")?.result?.replaceRequirementIds).toEqual([oldId]);
    expect(h.store.goals.getPreparationEpisode("replacement-answer")).toMatchObject({ goalId: created.id, objectiveVersion: 2, state: "ready" });
    expect(replaced.requirements).toHaveLength(1);
    expect(replaced.requirements[0]).toMatchObject({ id: expect.any(String), text: "检查新接口", replaces: [oldId], verification: { command: "new-check" },
      source: [{ kind: "input", inputId: "replacement-answer", quote: "new-check" }] });
    expect(replaced.requirements[0]!.id).not.toBe(oldId);
    expect(h.store.goals.getGoalVersion(created.id, 1)).toEqual(originalVersion);
    expect(h.store.conversations.getInput("replacement-answer")?.content).toContain("new-check");
    expect(await h.service.action("s1", created.id, answer)).toEqual(accepted);
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(5);
  });

  it("creates a new version for additional text sources even when the objective text is unchanged", async () => {
    const h = harness();
    const created = await h.service.create("s1", { requestId: "same-text-source", objective: "完成说明" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "executing", status: "paused" }));
    const input = { requestId: "additional-text-source", expectedRevision: h.store.goals.getGoal(created.id)!.revision, objective: "完成说明",
      changeKind: "refine" as const, changeReason: "新增使用示例要求", items: [{ type: "text" as const, text: "请另附使用示例" }] };
    const admitted = await h.service.update("s1", created.id, input);
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)).toMatchObject({ phase: "executing", objectiveVersion: 2, status: "paused" }));
    expect(h.store.goals.getGoalVersion(created.id, 2)).toMatchObject({ objective: "完成说明", previousVersion: 1, requestId: input.requestId,
      changeKind: "refine", changeReason: "新增使用示例要求" });
    expect(h.store.goals.getGoalVersion(created.id, 2)?.inputIds).toContain(input.requestId);
    expect(h.store.conversations.getInput(input.requestId)?.content).toContain("请另附使用示例");
    expect(await h.service.update("s1", created.id, input)).toEqual(admitted);
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(4);
  });

  it("retains ready under a closed budget and resumes without another preparation call or initial Run", async () => {
    let preparationCalls = 0;
    const h = harness(async (store, runId) => {
      const run = store.runs.getRun(runId)!;
      if (run.metadata.goalPhase === "preparing") {
        preparationCalls++;
        modelAttempt(store, runId, 5);
        assessment(store, runId, { decision: "ready", progressAssessment: { kind: "progress", summary: "明确条件" },
          preparedRequirements: [{ text: "完成说明", constraints: [], source: [{ kind: "input", inputId: run.inputId, quote: "完成说明" }],
            verification: { kind: "user_acceptance", question: "说明是否完整？" } }] });
      } else assessment(store, runId, { decision: "waiting_user", question: "还有需要补充的说明吗？", progressAssessment: { kind: "waiting", summary: "等待用户" } });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "ready-budget", objective: "完成说明", tokenBudget: 5 });
    await vi.waitFor(() => expect(h.store.goals.getPreparationEpisode("ready-budget")?.state).toBe("ready"));
    const stopped = h.store.goals.getGoal(created.id)!;
    expect(stopped).toMatchObject({ phase: "preparing", status: "paused", stopReason: { code: "token_budget" }, usage: { knownTokens: 5 } });
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(1);
    const budget = await h.service.action("s1", created.id, { requestId: "ready-budget-raise", expectedRevision: stopped.revision, action: "budget", tokenBudget: 20 });
    const resume = { requestId: "ready-resume", expectedRevision: budget.revision, action: "resume" as const };
    const resumed = await h.service.action("s1", created.id, resume);
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("waiting_user"));
    expect(await h.service.action("s1", created.id, resume)).toEqual(resumed);
    expect(preparationCalls).toBe(1);
    expect(h.store.goals.getPreparationEpisode("ready-budget")?.modelAttempts).toBe(1);
    expect(h.store.runs.listGoalRuns(created.id).map(run => run.metadata.goalRunKind)).toEqual(["preparation", "initial"]);
  });

  it("ordinary resume preserves the preparation episode while explicit reprepare starts one new batch", async () => {
    const h = harness(async (store, runId) => {
      modelAttempt(store, runId);
      assessment(store, runId, { decision: "blocked", reason: "需要缩小条件", progressAssessment: { kind: "no_progress", summary: "条件尚未明确", blockerKey: "scope" } });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "prepare-first", objective: "整理条件" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    const first = h.store.goals.getGoal(created.id)!;
    await h.service.action("s1", created.id, { requestId: "same-episode", expectedRevision: first.revision, action: "resume" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    const second = h.store.goals.getGoal(created.id)!;
    expect(second.preparationEpisodeId).toBe("prepare-first");
    expect(h.store.goals.getPreparationEpisode("prepare-first")?.modelAttempts).toBe(2);
    await expect(h.service.action("s1", created.id, { requestId: "exhausted-episode", expectedRevision: second.revision, action: "resume" })).rejects.toMatchObject({ status: 409 });
    const reprepare = { requestId: "new-episode", expectedRevision: second.revision, action: "resume" as const, reprepare: true };
    const accepted = await h.service.action("s1", created.id, reprepare);
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    expect(await h.service.action("s1", created.id, reprepare)).toEqual(accepted);
    expect(h.store.goals.getGoal(created.id)).toMatchObject({ preparationEpisodeId: "new-episode", objectiveVersion: 1, usage: { knownTokens: 3 } });
    expect(h.store.goals.getPreparationEpisode("new-episode")?.modelAttempts).toBe(1);
    expect(h.store.goals.listGoalVersions(created.id)).toHaveLength(1);
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(3);
  });

  it("records refine and pivot reasons once and leaves unchanged refine and frozen history intact", async () => {
    const h = harness();
    const created = await h.service.create("s1", { requestId: "audit-create", objective: "实现接口" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    const original = h.store.goals.getGoalVersion(created.id, 1)!;
    const paused = h.store.goals.getGoal(created.id)!;
    const unchanged = await h.service.update("s1", created.id, { requestId: "audit-unchanged", expectedRevision: paused.revision,
      objective: "实现接口", changeKind: "refine", changeReason: "补充说明但没有变更正文" });
    expect(unchanged.revision).toBe(paused.revision);
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(2);
    const refine = { requestId: "audit-refine", expectedRevision: unchanged.revision, objective: "实现接口并补文档",
      changeKind: "refine" as const, changeReason: "补充交付文档" };
    const admitted = await h.service.update("s1", created.id, refine);
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    expect(await h.service.update("s1", created.id, refine)).toEqual(admitted);
    expect(h.store.goals.getGoalVersion(created.id, 1)).toEqual(original);
    expect(h.store.goals.getGoalVersion(created.id, 2)).toMatchObject({ previousVersion: 1, changeKind: "refine", changeReason: "补充交付文档", actor: { kind: "local_user" } });
    const current = h.store.goals.getGoal(created.id)!;
    await h.service.update("s1", created.id, { requestId: "audit-pivot", expectedRevision: current.revision, objective: "改为整理设计稿",
      changeKind: "pivot", changeReason: "用户改变交付方向" });
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.status).toBe("paused"));
    expect(h.store.goals.listGoalVersions(created.id).map(version => version.changeKind)).toEqual(["create", "refine", "pivot"]);
    expect(h.service.get("s1")?.versionSummary).toMatchObject({ changeKind: "pivot", changeReason: "用户改变交付方向" });
    expect(h.store.runs.listGoalRuns(created.id)).toHaveLength(6);
  });

  it("does not offer acceptance for an unfinished check and confirms only the listed subjective requirement", async () => {
    let executionTurns = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(async (store, runId) => {
      const run = store.runs.getRun(runId)!;
      if (run.metadata.goalPhase === "preparing") {
        assessment(store, runId, { decision: "ready", progressAssessment: { kind: "progress", summary: "两项条件明确" }, preparedRequirements: [
          { text: "检查接口", constraints: [], source: [{ kind: "input", inputId: run.inputId, quote: "检查接口和界面" }], verification: { kind: "check", method: "检查接口", command: "run-check", environment: "local", expected: "通过" } },
          { text: "界面观感", constraints: [], source: [{ kind: "input", inputId: run.inputId, quote: "检查接口和界面" }], verification: { kind: "user_acceptance", question: "界面是否合适？" } },
        ] });
        return;
      }
      executionTurns++;
      if (executionTurns === 2) await gate;
      const goal = store.goals.getGoal(String(run.metadata.goalId))!;
      const message = store.conversations.createMessage({ sessionId: "s1", role: "assistant", runId });
      const part = store.conversations.upsertMessagePart({ sessionId: "s1", messageId: message.id, type: "tool", status: "completed", toolName: "Bash",
        input: { command: "run-check" }, output: { exitCode: 0 }, metadata: { executionState: "completed" } });
      assessment(store, runId, { decision: "complete", remainingWork: [], requirements: [
        { requirementId: goal.requirements[0]!.id, status: executionTurns === 1 ? "incomplete" : "satisfied", explanation: "接口检查结果", evidenceRefs: executionTurns === 1 ? [] : [{ messagePartId: part.id, criterion: "接口检查通过" }] },
        { requirementId: goal.requirements[1]!.id, status: "needs_user", explanation: "需要用户验收界面", evidenceRefs: [] },
      ] });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "specific-acceptance", objective: "检查接口和界面" });
    await vi.waitFor(() => expect(executionTurns).toBe(2));
    const unfinished = h.store.goals.getGoal(created.id)!;
    expect(unfinished.status).toBe("active");
    expect(unfinished.wait).toBeUndefined();
    await expect(h.service.action("s1", created.id, { requestId: "premature-confirm", expectedRevision: unfinished.revision, action: "confirm",
      questionId: "anything", objectiveVersion: 1 })).rejects.toMatchObject({ status: 409 });
    release();
    await vi.waitFor(() => expect(h.store.goals.getGoal(created.id)?.wait).toMatchObject({ purpose: "acceptance" }));
    const waiting = h.store.goals.getGoal(created.id)!;
    const wait = waiting.wait!;
    if (wait.kind !== "user") throw new Error("Expected user acceptance");
    const checkId = waiting.requirements[0]!.id;
    const subjectiveId = waiting.requirements[1]!.id;
    expect(wait.requirementIds).toEqual([subjectiveId]);
    const frozen = h.store.goals.getGoalVersion(created.id, 1)!;
    await expect(h.service.action("s1", created.id, { requestId: "stale-confirm", expectedRevision: waiting.revision, action: "confirm",
      questionId: wait.questionId, objectiveVersion: 2 })).rejects.toMatchObject({ status: 409 });
    const confirm = { requestId: "specific-confirm", expectedRevision: waiting.revision, action: "confirm" as const,
      questionId: wait.questionId, objectiveVersion: waiting.objectiveVersion };
    const completed = await h.service.action("s1", created.id, confirm);
    expect(completed.status).toBe("completed");
    expect(completed.assessment?.userReceipts).toMatchObject([{ requirementIds: [subjectiveId], actor: { kind: "local_user" } }]);
    expect(completed.assessment?.userReceipts?.[0].requirementIds).not.toContain(checkId);
    expect(h.store.goals.getGoalVersion(created.id, 1)).toEqual(frozen);
    expect(await h.service.action("s1", created.id, confirm)).toEqual(completed);
  });
  it("prepares and freezes one version before dispatching exactly one initial Run", async () => {
    const h = harness(async (store, runId) => {
      const run = store.runs.getRun(runId)!;
      if (run.metadata.goalRunKind === "preparation") assessment(store, runId, {
        decision: "ready", progressAssessment: { kind: "progress", summary: "条件明确" },
        preparedRequirements: [{ text: "完成文档", constraints: [],
          source: [{ kind: "input", inputId: run.inputId, quote: "完成文档" }],
          verification: { kind: "user_acceptance", question: "文档是否满足要求？" } }],
      });
      else store.runs.updateRun(runId, { status: "completed" });
    }, undefined, undefined, { autoPrepare: false });
    const created = await h.service.create("s1", { requestId: "c-create", objective: "完成文档" });
    expect(created.phase).toBe("preparing");
    await vi.waitFor(() => expect(h.service.get("s1")?.status).not.toBe("active"));
    const goal = h.service.get("s1")!;
    expect(goal).toMatchObject({ phase: "executing", objectiveVersion: 1 });
    expect(goal.requirements).toHaveLength(1);
    expect(h.store.runs.listRuns("s1").map(run => run.metadata.goalRunKind).sort()).toEqual(["initial", "preparation"]);
    expect(h.store.goals.getGoalVersion(goal.id, 1)?.frozenAt).toBeTypeOf("number");
  });
  it("keeps ambiguous input in clarification without dispatching execution", async () => {
    const h = harness(async (store, runId) => assessment(store, runId, {
      decision: "waiting_user", question: "需要优先改善哪项表现？",
      progressAssessment: { kind: "waiting", summary: "需要选择" },
    }), undefined, undefined, { autoPrepare: false });
    await h.service.create("s1", { requestId: "c-ambiguous", objective: "优化系统" });
    await vi.waitFor(() => expect(h.service.get("s1")?.status).not.toBe("active"));
    expect(h.service.get("s1")).toMatchObject({ phase: "preparing", status: "waiting_user",
      wait: { kind: "user", purpose: "clarification", objectiveVersion: 1 } });
    expect(h.store.runs.listRuns("s1")).toHaveLength(1);
  });
  it("changes a total Token budget without resuming or creating a Run", async () => {
    const h = harness();
    const created = currentFixtureGoal(h.store, { sessionId: "s1", objective: "验证预算", maxAutoTurns: 20 });
    const paused = h.store.goals.updateGoal(created.id, { expectedRevision: created.revision, status: "paused" });
    const input = { requestId: "budget-1", expectedRevision: paused.revision, action: "budget" as const, tokenBudget: 50000 };
    const saved = await h.service.action("s1", created.id, input);
    expect(saved).toMatchObject({ status: "paused", tokenBudget: 50000, objectiveVersion: 1 });
    expect(h.store.runs.listRuns("s1")).toHaveLength(0);
    expect(await h.service.action("s1", created.id, input)).toEqual(saved);
  });
  it("returns the cancelled Goal and its late usage through the same session GET", () => {
    const h = harness();
    const goal = currentFixtureGoal(h.store, { sessionId: "s1", objective: "终态补账", maxAutoTurns: 20 });
    h.store.runs.createRun({ id: "late", sessionId: "s1", metadata: { goalId: goal.id, goalObjectiveVersion: 1, goalPhase: "executing" } });
    h.store.runs.updateRun("late", { status: "running" });
    const key = { runId: "late", sessionId: "s1", generationId: "gen", attempt: 1 };
    h.store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" });
    h.store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "cancelled" });
    h.store.goals.recordGoalModelAttempt({ ...key, status: "completed", usageStatus: "complete", metering: {
      knownInputTokens: 10, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: true, raw: { input: 10, output: 2 },
    } });
    expect(h.service.get("s1")).toMatchObject({ id: goal.id, status: "cancelled", usage: { knownTokens: 12, seq: 2 } });
    expect(h.store.goals.getCurrentGoal("s1")).toBeUndefined();
  });
  it("requires an explicit budget change before resuming missing usage and never clears the ledger", async () => {
    const h = harness();
    const goal = currentFixtureGoal(h.store, { sessionId: "s1", objective: "有限目标", maxAutoTurns: 20, tokenBudget: 20 });
    h.store.runs.createRun({ id: "metered", sessionId: "s1", metadata: { goalId: goal.id, goalObjectiveVersion: 1, goalPhase: "executing" } });
    h.store.runs.updateRun("metered", { status: "running" });
    const key = { runId: "metered", sessionId: "s1", generationId: "gen", attempt: 1 };
    h.store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" });
    h.store.goals.recordGoalModelAttempt({ ...key, status: "failed", usageStatus: "partial", metering: {
      knownInputTokens: 7, knownOutputTokens: 0, completeness: "partial", inputIncludesCache: true, raw: { input: 7 },
    } });
    h.store.runs.updateRun("metered", { status: "interrupted" });
    let paused = h.store.goals.getGoal(goal.id)!;
    await expect(h.service.action("s1", goal.id, { requestId: "resume-unknown", expectedRevision: paused.revision, action: "resume" })).rejects.toThrow("预算");
    paused = await h.service.action("s1", goal.id, { requestId: "unlimit", expectedRevision: paused.revision, action: "budget", tokenBudget: null });
    expect(paused).toMatchObject({ status: "paused", usage: { knownTokens: 7, incomplete: true } });
    const resumed = await h.service.action("s1", goal.id, { requestId: "resume-unlimited", expectedRevision: paused.revision, action: "resume" });
    expect(resumed).toMatchObject({ status: "active", usage: { knownTokens: 7, incomplete: true } });
    await drainRuns(h.store, h.control);
  });

  it("saves edited text under a closed budget without leaving an undeliverable request", async () => {
    const h = harness();
    const created = await h.service.create("s1", { requestId: "budget-edit-source", objective: "原目标", maxAutoTurns: 20, tokenBudget: 10 });
    await drainRuns(h.store, h.control);
    let goal = h.store.goals.getGoal(created.id)!;
    goal = h.store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "active" });
    h.store.runs.createRun({ id: "metered", sessionId: "s1", metadata: { goalId: goal.id, goalObjectiveVersion: 1, goalPhase: "executing" } });
    h.store.runs.updateRun("metered", { status: "running" });
    const key = { runId: "metered", sessionId: "s1", generationId: "gen", attempt: 1 };
    h.store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" });
    h.store.goals.recordGoalModelAttempt({ ...key, status: "completed", usageStatus: "complete", metering: {
      knownInputTokens: 9, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: true, raw: { input: 9, output: 2 },
    } });
    const paused = h.store.goals.getGoal(goal.id)!;
    const input = { requestId: "edit-budget", changeKind: "refine" as const, changeReason: "补充目标要求", expectedRevision: paused.revision, objective: "新的目标" };
    const edited = await h.service.update("s1", goal.id, input);
    expect(edited).toMatchObject({ objective: "新的目标", objectiveVersion: 2, status: "paused", stopReason: { code: "token_budget" }, usage: { knownTokens: 11 } });
    expect(h.store.runs.listGoalRuns(goal.id)).toHaveLength(3);
    expect(h.store.goals.getGoalRequest(input.requestId)?.status).toBe("completed");
    expect(await h.service.update("s1", goal.id, input)).toEqual(edited);
  });
  it.each([
    ["missing-assessment", "assessment_invalid"], ["missing-next-step", "assessment_invalid"],
    ["run-failed", "run_error"], ["invalid-wait", "wait_invalid"],
    ["wait-timeout", "wait_timeout"], ["external-failed", "external_failed"],
  ])("records a structured stop for %s", async (scenario, code) => {
    const { service, store, control } = harness(async (store, runId) => {
      if (scenario === "missing-assessment") { store.runs.updateRun(runId, { status: "completed" }); return; }
      const waits = scenario.includes("wait") || scenario === "external-failed";
      assessment(store, runId, {
        ...(scenario === "missing-next-step" ? { nextStep: undefined } : {}),
        ...(waits ? { progressAssessment: { kind: "waiting", summary: "等待构建" },
          wait: { kind: "external", targetRunId: "child", deadlineAt: Date.now() + 60000 } } : {}),
      }, scenario === "run-failed" ? "failed" : "completed");
    }, { check: () => scenario === "wait-timeout" ? { state: "failed", code: "wait_timeout", reason: "超时" }
      : scenario === "external-failed" ? { state: "failed", code: "external_failed", reason: "失败" } : { state: "missing" } });
    const goal = await service.create("s1", { requestId: scenario, objective: "finish" });
    await drainRuns(store, control);
    expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "paused", stopReason: { code } });
  });

  function persistedWait(store: SessionStore, maxAutoTurns = 2) {
    const goal = currentFixtureGoal(store, { sessionId: "s1", objective: "检查外部结果", maxAutoTurns });
    const metadata = { goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion, goalPhase: "executing" };
    store.runs.createRun({ id: "wait-owner", sessionId: "s1", metadata });
    store.runs.updateRun("wait-owner", { status: "completed" });
    return store.goals.updateGoal(goal.id, {
      expectedRevision: store.goals.getGoal(goal.id)!.revision,
      wait: { kind: "external", goalId: goal.id, objectiveVersion: goal.objectiveVersion,
        ownerRunId: "wait-owner", targetRunId: "wait-child", deadlineAt: Date.now() + 60000 },
    });
  }

  it("defers a completed wait for user work and then admits exactly once", async () => {
    vi.useFakeTimers();
    try {
      let turns = 0;
      const { service, store, control } = harness(async (store, runId) => {
        turns++;
        assessment(store, runId, { decision: "waiting_user", question: "验收？", progressAssessment: { kind: "waiting", summary: "验收" } });
      }, { check: () => ({ state: "completed" }) });
      const goal = persistedWait(store);
      store.runs.createRun({ id: "user-work", sessionId: "s1", metadata: {} });
      service.recoverExternalWaits();
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.goals.getGoal(goal.id)?.wait?.kind).toBe("external");
      expect(turns).toBe(0);
      store.runs.updateRun("user-work", { status: "completed" });
      await vi.advanceTimersByTimeAsync(2000);
      await drainRuns(store, control);
      expect(turns).toBe(1);
      expect(store.runs.listRuns("s1").filter((run) => run.metadata.goalWaitSource)).toHaveLength(1);
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(30000);
      expect(turns).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("pauses a completed wait when automatic turns are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const { service, store } = harness(undefined, { check: () => ({ state: "completed" }) });
      const goal = persistedWait(store, 1);
      store.goals.updateGoal(goal.id, { expectedRevision: store.goals.getGoal(goal.id)!.revision, autoTurnsUsed: 1 });
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "paused", stopReason: { code: "auto_turn_limit" }, autoTurnsUsed: 1 });
      expect(store.runs.listRuns("s1")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("waits for pending approval when an external result completes and cannot resume a denial", async () => {
    vi.useFakeTimers();
    try {
      const { service, store } = harness(undefined, { check: () => ({ state: "completed" }) });
      const goal = persistedWait(store);
      const permission = store.permissions.create({ sessionId: "s1", toolName: "Bash", payload: {} });
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1000);
      const waiting = store.goals.getGoal(goal.id)!;
      expect(waiting).toMatchObject({ status: "waiting_user", wait: { kind: "approval", permissionRequestId: permission.id } });
      expect(store.runs.listRuns("s1")).toHaveLength(1);
      store.permissions.reply({ requestId: permission.id, status: "denied" });
      await expect(service.action("s1", goal.id, { requestId: "denied-wait", action: "resume", expectedRevision: waiting.revision }))
        .rejects.toThrow("批准尚未通过");
    } finally { vi.useRealTimers(); }
  });

  it("settles the current Run across a state revision change without changing objective identity", async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const { service, store, control } = harness(async (store, runId) => {
      await done;
      assessment(store, runId, { decision: "waiting_user", question: "验收？", progressAssessment: { kind: "waiting", summary: "验收" } });
    });
    const goal = await service.create("s1", { requestId: "state-revision", objective: "finish" });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.phase).toBe("executing"));
    store.goals.updateGoal(goal.id, { expectedRevision: store.goals.getGoal(goal.id)!.revision, maxAutoTurns: 30 });
    finish();
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("waiting_user"));
    await drainRuns(store, control);
    expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "waiting_user", objectiveVersion: 1 });
    expect(store.goals.getGoal(goal.id)!.revision).toBeGreaterThan(goal.revision);
  });

  it("rolls wait admission back if its continuation record cannot be saved", async () => {
    vi.useFakeTimers();
    try {
      const { service, store } = harness(undefined, { check: () => ({ state: "completed" }) });
      const goal = persistedWait(store);
      const beforeEvents = store.conversations.listEvents();
      const beforeInputs = store.conversations.listInputs("s1");
      const record = vi.spyOn(store.goals, "recordGoalContinuation").mockReturnValue(false);
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.goals.getGoal(goal.id)).toEqual(goal);
      expect(store.runs.listRuns("s1")).toHaveLength(1);
      expect(store.conversations.listInputs("s1")).toEqual(beforeInputs);
      expect(store.conversations.listEvents()).toEqual(beforeEvents);
      record.mockRestore();
      await service.action("s1", goal.id, { requestId: "stop-rollback", action: "pause", expectedRevision: store.goals.getGoal(goal.id)!.revision });
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("reuses a failed wait dispatch through resume and its same-request retry (user pause=%s)", async (pauseAfterFailure) => {
    vi.useFakeTimers();
    try {
      let turns = 0;
      const { service, store, admission, control } = harness(async (store, runId) => {
        turns++;
        assessment(store, runId, { decision: "waiting_user", question: "验收？", progressAssessment: { kind: "waiting", summary: "验收" } });
      }, { check: () => ({ state: "completed" }) });
      const goal = persistedWait(store);
      const dispatch = vi.spyOn(admission, "dispatchPersistedRun").mockImplementation(() => { throw new Error("queue unavailable"); });
      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1000);
      const failed = store.goals.getGoal(goal.id)!;
      expect(failed).toMatchObject({ status: "paused", stopReason: { code: "run_error" } });
      const original = store.runs.getRun(failed.stopReason!.runId!)!;
      const continuation = store.goals.findGoalContinuation(original.id)!;
      const input = { requestId: "resume-wait", action: "resume" as const, expectedRevision: failed.revision };
      await expect(service.action("s1", goal.id, input)).rejects.toThrow("queue unavailable");
      expect(store.goals.getGoalRequest(input.requestId)).toMatchObject({ status: "pending", result: { runId: original.id } });
      dispatch.mockRestore();
      if (pauseAfterFailure) {
        const current = store.goals.getGoal(goal.id)!;
        await service.action("s1", goal.id, { requestId: "explicit-pause", action: "pause", expectedRevision: current.revision });
        await expect(service.action("s1", goal.id, input)).rejects.toMatchObject({ status: 409 });
        expect(store.goals.getGoal(goal.id)?.stopReason?.code).toBe("user_paused");
        expect(turns).toBe(0);
      } else {
        await service.action("s1", goal.id, input);
        await control.waitForRuns([original.id]);
        expect(turns).toBe(1);
        expect(store.goals.getGoal(goal.id)?.autoTurnsUsed).toBe(1);
        expect(store.runs.findRunByInput(original.inputId!)?.id).toBe(original.id);
        expect(store.goals.findGoalContinuation(original.id)).toMatchObject({ ...continuation, status: "dispatched" });
      }
      expect(store.runs.listRuns("s1")).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(["create", "update"] as const)("replays accepted %s after its plugin becomes unavailable", async (operation) => {
    const { service, store, control, admission, disablePlugins } = harness();
    const original = operation === "update"
      ? await service.create("s1", { requestId: "original", objective: "original" }) : undefined;
    await drainRuns(store, control);
    const input = { requestId: "accepted-plugin", objective: "review", items: [{ type: "capability" as const, kind: "plugin" as const, pluginId, displayName: "Quality" }] };
    const revision = original ? store.goals.getGoal(original.id)!.revision : 0;
    const request = (objective = input.objective) => original
      ? service.update("s1", original.id, { changeKind: "refine", changeReason: "补充目标要求", ...input, objective, expectedRevision: revision })
      : service.create("s1", { ...input, objective });
    const accepted = await request();
    await drainRuns(store, control);
    const runs = store.runs.listRuns("s1");
    disablePlugins();
    await expect(request()).resolves.toEqual(accepted);
    expect(store.runs.listRuns("s1")).toEqual(runs);
    await expect(request("different request")).rejects.toThrow("session_goal_request_conflict");
  });

  it.each(["create", "update"] as const)("recovers persisted %s dispatch without readmitting its unavailable plugin", async (operation) => {
    const { service, store, control, admission, disablePlugins } = harness();
    const original = operation === "update"
      ? await service.create("s1", { requestId: "original", objective: "original" }) : undefined;
    await drainRuns(store, control);
    const input = { requestId: "recover-plugin", objective: "review", items: [{ type: "capability" as const, kind: "plugin" as const, pluginId, displayName: "Quality" }] };
    const revision = original ? store.goals.getGoal(original.id)!.revision : 0;
    const request = () => original
      ? service.update("s1", original.id, { changeKind: "refine", changeReason: "补充目标要求", ...input, expectedRevision: revision })
      : service.create("s1", input);
    vi.spyOn(admission, "dispatchPersistedRun").mockImplementationOnce(() => { throw new Error("dispatch failed"); });
    await expect(request()).rejects.toThrow("dispatch failed");
    const persisted = store.runs.findRunByInput(input.requestId)!;
    const count = store.runs.listRuns("s1").length;
    disablePlugins();
    await expect(request()).resolves.toMatchObject({ pluginId });
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(count + 1);
    expect(store.runs.findRunByInput(input.requestId)).toMatchObject({ id: persisted.id, status: "completed", metadata: { pluginId } });
    expect(store.goals.getGoalRequest(input.requestId)?.status).toBe("completed");
  });

  it("retains the admitted replacement plugin when an edit resumes after stopping failed", async () => {
    const { service, store, control, admission, disablePlugins } = harness();
    const original = await service.create("s1", { requestId: "original", objective: "original" });
    await drainRuns(store, control);
    const input = {
      requestId: "recover-stopping", changeKind: "refine" as const, changeReason: "补充目标要求", expectedRevision: store.goals.getGoal(original.id)!.revision, objective: "research",
      items: [{ type: "capability" as const, kind: "plugin" as const, pluginId: "dev.vykor.research", displayName: "Research" }],
    };
    vi.spyOn(control, "waitForRuns").mockRejectedValueOnce(new Error("stop failed"));
    await expect(service.update("s1", original.id, input)).rejects.toThrow("stop failed");
    disablePlugins();
    await expect(service.update("s1", original.id, input)).resolves.toMatchObject({ pluginId: "dev.vykor.research" });
    await drainRuns(store, control);
    expect(store.runs.findRunByInput(input.requestId)?.metadata.pluginId).toBe("dev.vykor.research");
    expect(store.runs.listRuns("s1")).toHaveLength(4);
  });

  it("carries an admitted plugin through initial and continuation runs", async () => {
    let turns = 0;
    const views: RunCapabilityView[] = [];
    let runtimeTools = new ToolRegistry();
    runtimeTools.register({ name: "BeforeUpdate", description: "before", inputSchema: {}, execute: async () => ({ content: [] }) }, { kind: "plugin", id: pluginId });
    const { service, store } = harness(async (store, runId) => {
      assessment(store, runId, ++turns === 1 ? {} : { decision: "waiting_user", question: "确认结果？" });
      // A management invalidation replaces the runtime before the next acquisition.
      runtimeTools = new ToolRegistry();
      runtimeTools.register({ name: "AfterUpdate", description: "after", inputSchema: {}, execute: async () => ({ content: [] }) }, { kind: "plugin", id: pluginId });
    }, undefined, (selected) => {
      const view = createRunCapabilityView({ toolRegistry: runtimeTools, pluginIds: new Set([pluginId]) }, selected);
      views.push(view);
      return view;
    });

    const goal = await service.create("s1", {
      requestId: "plugin-goal-create",
      objective: "use plugin",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.vykor.quality",
        displayName: "Quality",
      }],
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status, store.goals.getGoal(goal.id)?.reason).toBe("waiting_user"));
    expect(goal).toMatchObject({ pluginId });
    const runs = store.runs.listRuns("s1");
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.metadata.goalRunKind)).toEqual(["preparation", "initial", "continuation"]);
    for (const run of runs) {
      expect(run.metadata.pluginId).toBe(pluginId);
      expect(store.conversations.getInput(run.inputId!)?.metadata.pluginId).toBe(pluginId);
    }
    expect(store.goals.getGoal(goal.id)).not.toHaveProperty("snapshot");
    expect(views.map((view) => [...view.tools.keys()])).toEqual([["BeforeUpdate"], ["BeforeUpdate"], ["AfterUpdate"]]);
    expect(views[0]).not.toBe(views[1]);
  });

  it("pauses and preserves audit records when the rebuilt runtime excludes the selected plugin", async () => {
    let available = true;
    let submitted = 0;
    const { service, store } = harness(async (store, runId) => {
      submitted++;
      assessment(store, runId, {});
      available = false;
    }, undefined, (selected) => createRunCapabilityView({
      toolRegistry: new ToolRegistry(), pluginIds: new Set(available ? [pluginId] : []),
    }, selected));
    const goal = await service.create("s1", {
      requestId: "plugin-becomes-unavailable", objective: "review",
      items: [{ type: "capability", kind: "plugin", pluginId, displayName: "Quality" }],
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    const runs = store.runs.listRuns("s1");
    expect(submitted, store.goals.getGoal(goal.id)?.reason).toBe(1);
    expect(runs).toHaveLength(3);
    expect(runs[2]).toMatchObject({ status: "failed", metadata: { pluginId } });
    expect(store.goals.getGoal(goal.id)).toMatchObject({ pluginId, reason: runs[2]!.error });
    expect(runs[2]!.error).toContain(pluginId);
    expect(store.conversations.getInput(runs[2]!.inputId!)?.metadata.pluginId).toBe(pluginId);
  });

  it("rejects an unavailable plugin Agent before updating a Goal", async () => {
    const { service, store, control, admission } = harness();
    const created = await service.create("s1", {
      requestId: "ordinary-goal-create",
      objective: "ordinary goal",
    });
    await drainRuns(store, control);
    const beforeUpdate = store.goals.getGoal(created.id)!;

    await expect(service.update("s1", created.id, { changeKind: "refine", changeReason: "补充目标要求",
      requestId: "plugin-goal-update",
      expectedRevision: beforeUpdate.revision,
      objective: "use plugin",
      items: [{
        type: "capability",
        kind: "plugin_agent",
        pluginId: "dev.vykor.quality",
        agentId: "dev.vykor.quality:reviewer",
        displayName: "Reviewer",
      }],
    })).rejects.toThrow("session_plugin_capability_unavailable");

    expect(store.goals.getGoal(created.id)).toMatchObject({
      objective: "ordinary goal",
      revision: beforeUpdate.revision,
    });
    expect(store.conversations.getInput("plugin-goal-update")).toBeUndefined();
    expect(store.goals.getGoalRequest("plugin-goal-update")).toBeUndefined();
  });

  it("uses trusted Skill ownership even when its source claims user", async () => {
    const { service, store, control, admission } = harness();

    const goal = await service.create("s1", {
      requestId: "forged-plugin-skill-create",
      objective: "use plugin skill",
      items: [{ type: "skill", source: "user", ...pluginSkill }],
    });
    await drainRuns(store, control);
    expect(goal).toMatchObject({ pluginId });
    expect(store.conversations.getInput("forged-plugin-skill-create")?.metadata.pluginId).toBe(pluginId);
  });

  it("changes plugin selection on explicit edit and retains it on text edit and resume", async () => {
    const { service, store, control, admission } = harness();
    const created = await service.create("s1", {
      requestId: "ordinary-goal-for-skill-update",
      objective: "ordinary goal",
    });
    await drainRuns(store, control);
    const beforeUpdate = store.goals.getGoal(created.id)!;

    const edited = await service.update("s1", created.id, { changeKind: "refine", changeReason: "补充目标要求",
      requestId: "implicit-plugin-skill-update",
      expectedRevision: beforeUpdate.revision,
      objective: "use plugin skill",
      items: [{ type: "skill", ...pluginSkill }],
    });
    expect(edited).toMatchObject({ pluginId });
    await drainRuns(store, control);
    const textEdited = await service.update("s1", created.id, { changeKind: "refine", changeReason: "补充目标要求",
      requestId: "text-edit", expectedRevision: store.goals.getGoal(created.id)!.revision,
      objective: "clarified objective", items: [{ type: "text", text: "clarified" }],
    });
    expect(textEdited).toMatchObject({ pluginId });
    await drainRuns(store, control);
    const resumed = await service.action("s1", created.id, {
      requestId: "resume-plugin", expectedRevision: store.goals.getGoal(created.id)!.revision,
      action: "resume",
    });
    await drainRuns(store, control);
    expect(resumed).toMatchObject({ pluginId });
    expect(store.conversations.getInput("resume-plugin")?.metadata).toMatchObject({
      transcriptVisibility: "hidden",
    });
    for (const id of ["implicit-plugin-skill-update", "text-edit", "resume-plugin"]) {
      expect(store.conversations.getInput(id)?.metadata.pluginId).toBe(pluginId);
      expect(store.runs.findRunByInput(id)?.metadata.pluginId).toBe(pluginId);
    }
    const switched = await service.update("s1", created.id, { changeKind: "refine", changeReason: "补充目标要求",
      requestId: "switch-plugin", expectedRevision: store.goals.getGoal(created.id)!.revision,
      objective: "research instead",
      items: [{ type: "capability", kind: "plugin", pluginId: "dev.vykor.research", displayName: "Research" }],
    });
    await drainRuns(store, control);
    expect(switched).toMatchObject({ pluginId: "dev.vykor.research" });
    expect(store.runs.findRunByInput("switch-plugin")?.metadata.pluginId).toBe("dev.vykor.research");
    await service.action("s1", created.id, {
      requestId: "cancel-plugin", expectedRevision: store.goals.getGoal(created.id)!.revision, action: "cancel",
    });
    expect(store.goals.getGoal(created.id)?.status).toBe("cancelled");
    expect(store.conversations.getInput("resume-plugin")?.metadata.pluginId).toBe(pluginId);
    expect(store.runs.findRunByInput("switch-plugin")?.metadata.pluginId).toBe("dev.vykor.research");
  });

  it("keeps a pause request pending until cleanup finishes and shares concurrent retries", async () => {
    let release!: () => void;
    const cleanupGate = new Promise<void>((done) => {
      release = done;
    });
    let activeSignal: AbortSignal | undefined;
    const { service, store, control, admission } = harness(async (store, runId, signal) => {
      activeSignal = signal;
      await cleanupGate;
      store.runs.updateRun(runId, {
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
      expectedRevision: store.goals.getGoal(created.id)!.revision,
      action: "pause" as const,
    };
    const first = service.action("s1", created.id, command);
    const second = service.action("s1", created.id, command);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
    expect(store.goals.getGoalRequest(command.requestId)?.status).toBe("pending");
    expect(store.goals.getGoal(created.id)?.currentRunId).toBeDefined();
    release();
    const stopped = await first;
    await drainRuns(store, control);
    expect(stopped.status).toBe("paused");
    expect(stopped.stopReason?.code).toBe("user_paused");
    expect(stopped.currentRunId).toBeUndefined();
    expect(store.goals.getGoalRequest(command.requestId)?.status).toBe("completed");
    expect(await service.action("s1", created.id, command)).toEqual(stopped);
  });

  it.each([false, true])("automatically completes after a verified continuation (plugin=%s)", async (withPlugin) => {
    let turns = 0;
    const { service, store, control, admission } = harness(async (store, runId) => {
      const message = store.conversations.createMessage({
        sessionId: "s1",
        role: "assistant",
        runId,
      });
      const part = store.conversations.upsertMessagePart({
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "completed",
        toolName: "Bash",
        input: { command: "run-check" },
        output: { exitCode: 0, checked: ++turns },
        metadata: { executionState: "completed" },
      });
      assessment(store, runId, {
        decision: turns === 2 ? "complete" : "continue",
        evidence: ["实际检查通过"],
        evidenceRefs: [{ messagePartId: part.id, criterion: "相关检查通过" }],
        ...(turns === 2
          ? {
              requirements: [
                {
                  requirementId: requirementId(store, runId), explanation: "通过两项实际检查",
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
      ...(withPlugin ? { items: [{ type: "capability" as const, kind: "plugin" as const, pluginId, displayName: "Quality" }] } : {}),
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("completed"));
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(3);
    expect(store.goals.getGoal(goal.id)?.autoTurnsUsed).toBe(1);
    expect(store.goals.getGoal(goal.id)?.pluginId).toBe(withPlugin ? pluginId : undefined);
    for (const run of store.runs.listRuns("s1")) {
      expect(run.metadata.pluginId).toBe(withPlugin ? pluginId : undefined);
      expect(store.conversations.getInput(run.inputId!)?.metadata.pluginId).toBe(withPlugin ? pluginId : undefined);
    }
  });

  it("lets a queued user run assess the goal before any automatic continuation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const executed: string[] = [];
    const { service, store, control, admission } = harness(async (store, runId) => {
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
    const user = await admission.admitPromptAndMaybeRun("s1", {
      id: "user-priority",
      items: [{ type: "text", text: "先回答这个问题" }],
    });
    release();
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("waiting_user"));
    await drainRuns(store, control);
    expect(executed).toEqual([store.runs.listGoalRuns(goal.id).find(run => run.metadata.goalRunKind === "initial")!.id, user.run!.id]);
    expect(store.runs.getRun(user.run!.id)?.metadata.goalRunKind).toBe("user");
    expect(store.goals.getGoal(goal.id)?.autoTurnsUsed).toBe(0);
    expect(store.goals.getGoal(goal.id)?.wait).toMatchObject({
      question: "采用用户刚提出的选项吗？",
    });
  });

  it("pauses at the turn budget and rejects approval bypass", async () => {
    const { service, store, control, admission } = harness(async (store, runId) => assessment(store, runId, {}));
    const goal = await service.create("s1", {
      requestId: "budget",
      objective: "有限续跑",
      maxAutoTurns: 1,
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    await drainRuns(store, control);
    const paused = store.goals.getGoal(goal.id)!;
    expect(paused.autoTurnsUsed).toBe(1);
    await expect(
      service.action("s1", goal.id, {
        requestId: "no-budget",
        action: "resume",
        expectedRevision: paused.revision,
      }),
    ).rejects.toThrow("增加");
    const permission = store.permissions.create({
      sessionId: "s1",
      toolName: "Bash",
      payload: {},
    });
    const waiting = store.goals.updateGoal(goal.id, {
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
    expect(store.goals.getGoal(goal.id)?.status).toBe("waiting_user");
  });

  it("rolls back the goal and input when attachment admission fails, then permits the same request to retry", async () => {
    const { service, store } = harness();
    const input = {
      requestId: "bad-attachment",
      objective: "修复并验证",
      attachments: [{ assetId: "missing", intent: "context" as const }],
    };
    await expect(service.create("s1", input)).rejects.toThrow();
    expect(store.goals.getCurrentGoal("s1")).toBeUndefined();
    expect(store.conversations.getInput(input.requestId)).toBeUndefined();
    expect(store.runs.listRuns("s1")).toHaveLength(0);
    expect(store.goals.getGoalRequest(input.requestId)?.goalId).toBeUndefined();
    await expect(service.create("s1", input)).rejects.toThrow();
    expect(store.runs.listRuns("s1")).toHaveLength(0);
  });

  it("replays committed admission after a dispatch failure without creating a second goal, input or run", async () => {
    const { service, store, control, admission } = harness();
    const dispatch = vi.spyOn(admission, "dispatchPersistedRun");
    dispatch.mockImplementationOnce(() => {
      throw new Error("dispatch unavailable");
    });
    const input = { requestId: "create-once", objective: "完成目标" };
    await expect(service.create("s1", input)).rejects.toThrow("dispatch unavailable");
    expect(store.runs.listRuns("s1")).toHaveLength(1);
    const goalId = store.goals.getCurrentGoal("s1")!.id;
    const goal = await service.create("s1", input);
    expect(goal.id).toBe(goalId);
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(2);
    expect(store.goals.getGoalRequest(input.requestId)?.status).toBe("completed");
    expect(await service.create("s1", input)).toEqual(goal);
    await expect(service.create("s1", { ...input, objective: "不同目标" })).rejects.toMatchObject({ status: 409 });
  });

  it("pauses after three settled rounds without evidence and does not count a repeated settlement", async () => {
    const { service, store, control, admission } = harness(async (store, runId) => assessment(store, runId, { evidence: ["模型说有进展"] }));
    const goal = await service.create("s1", {
      requestId: "three-rounds",
      objective: "完成并验证",
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    await drainRuns(store, control);
    expect(store.goals.getGoal(goal.id)).toMatchObject({
      autoTurnsUsed: 2,
      noProgressCount: 0, stagnationCount: 3,
      stopReason: { code: "no_progress" },
    });
    expect(store.goals.getGoal(goal.id)?.currentRunId).toBeUndefined();
    expect(store.runs.listRuns("s1")).toHaveLength(4);
    const last = store.runs.listRuns("s1").at(-1)!;
    await service.settleRun("s1", last.id);
    expect(store.runs.listRuns("s1")).toHaveLength(4);
    expect(store.goals.getGoal(goal.id)?.stagnationCount).toBe(3);
  });

  it("changing model blocker descriptions cannot reset three rounds without verified progress", async () => {
    let turns = 0;
    const blockers = ["missing-a", "missing-b", "missing-b", "missing-b"];
    const { service, store, control, admission } = harness(async (store, runId) => {
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
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(4);
    expect(store.goals.getGoal(goal.id)).toMatchObject({
      noProgressCount: 0, stagnationCount: 3,
      blockerKey: "missing-b",
    });
  });

  it("blocks after three rounds of the same verified tool failure when no route remains", async () => {
    let turns = 0;
    const blockers = ["missing-a", "missing-a", "missing-a"];
    const { service, store, control, admission } = harness(async (store, runId) => {
      const blockerKey = blockers[turns++]!;
      const message = store.conversations.createMessage({ sessionId: "s1", role: "assistant", runId });
      const part = store.conversations.upsertMessagePart({ sessionId: "s1", messageId: message.id, type: "tool", status: "failed",
        toolName: "Read", isError: true, input: { path: "config" }, output: [{ type: "text", text: "required config unavailable" }] });
      assessment(store, runId, {
        decision: "blocked",
        progressAssessment: {
          kind: "no_progress",
          summary: `no progress: ${blockerKey}`,
          blockerKey,
        },
        reason: blockerKey,
        evidenceRefs: [{ messagePartId: part.id, criterion: "配置不可用" }],
        ...(turns === 3 ? { nextStep: undefined } : {}),
      });
    });
    const goal = await service.create("s1", {
      requestId: "blocker-consecutive",
      objective: "连续同一 blockerKey 阻塞三轮",
      maxAutoTurns: 5,
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("blocked"));
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(4);
    expect(store.goals.getGoal(goal.id)).toMatchObject({
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
      const { service, store, control, admission } = harness(
        async (store, runId) => {
          turns += 1;
          if (turns === 1)
            assessment(store, runId, {
              progressAssessment: { kind: "waiting", summary: "构建仍在运行" },
              wait: {
                kind: "external",
                targetRunId: "build-run",
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
      await drainRuns(store, control);
      expect(store.goals.getGoal(goal.id)).toMatchObject({
        status: "active",
        wait: { kind: "external", targetRunId: "build-run" },
        autoTurnsUsed: 0,
      });
      const waiting = store.goals.getGoal(goal.id);
      const originalRuns = store.runs.listRuns("s1");
      // Three unchanged program checks must retain the handle and durable state
      // without admitting another model Run.
      await vi.advanceTimersByTimeAsync(7_000);
      expect(store.goals.getGoal(goal.id)).toEqual(waiting);
      expect(store.runs.listRuns("s1")).toEqual(originalRuns);
      expect(turns).toBe(1);
      check = "completed";
      await vi.advanceTimersByTimeAsync(8_000);
      await drainRuns(store, control);
      expect(store.goals.getGoal(goal.id)).toMatchObject({
        status: "waiting_user",
        autoTurnsUsed: 1,
      });
      expect(turns).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(turns).toBe(2);
      expect(store.runs.listRuns("s1")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reattaches a persisted external wait after the goal service restarts", async () => {
    vi.useFakeTimers();
    try {
      let turns = 0;
      const { service, store, control } = harness(
        async (store, runId) => {
          turns += 1;
          assessment(store, runId, {
            decision: "waiting_user",
            progressAssessment: { kind: "waiting", summary: "等待验收" },
            question: "请验收",
          });
        },
        { check: () => ({ state: "completed" }) },
      );
      const created = currentFixtureGoal(store, { sessionId: "s1", objective: "重启后继续", maxAutoTurns: 2 });
      store.goals.updateGoal(created.id, {
        expectedRevision: store.goals.getGoal(created.id)!.revision,
        wait: { kind: "external", targetRunId: "build-run", ownerRunId: "old-run", goalId: created.id, objectiveVersion: created.objectiveVersion, deadlineAt: Date.now() + 60_000 },
      });

      service.recoverExternalWaits();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainRuns(store, control);

      expect(store.goals.getGoal(created.id)).toMatchObject({ status: "waiting_user", wait: { kind: "user" } });
      expect(turns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not complete a failed run even if it submitted complete", async () => {
    const { service, store, control, admission } = harness(async (store, runId) => {
      assessment(store, runId, { decision: "complete" }, "failed");
    });
    const goal = await service.create("s1", {
      requestId: "failed-run",
      objective: "验证目标",
    });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    await drainRuns(store, control);
    expect(store.goals.getGoal(goal.id)?.reason).toBe("verification failed");
  });

  it("continues instead of completing while audited work remains", async () => {
    let turns = 0;
    const { service, store, control, admission } = harness(async (store, runId) => {
      turns += 1;
      if (turns === 1) {
        assessment(store, runId, {
          decision: "complete",
          requirements: [
            {
              requirementId: requirementId(store, runId), explanation: "补充文档",
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
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("waiting_user"));
    await drainRuns(store, control);
    expect(store.runs.listRuns("s1")).toHaveLength(3);
  });

  it("requires the matching question to confirm subjective completion and replays confirmation once", async () => {
    const { service, store, control, admission } = harness(async (store, runId) =>
      assessment(store, runId, {
        decision: "complete",
        requirements: [
          {
            requirementId: requirementId(store, runId), explanation: "页面观感舒服",
            status: "needs_user",
            evidenceRefs: [],
          },
        ],
        remainingWork: [],
      }), undefined, undefined, { verification: { kind: "user_acceptance", question: "页面观感舒服吗？" } });
    const created = await service.create("s1", {
      requestId: "subjective",
      objective: "让页面更舒服",
    });
    await vi.waitFor(() => expect(store.goals.getGoal(created.id)?.status).toBe("waiting_user"));
    await drainRuns(store, control);
    const goal = store.goals.getGoal(created.id)!;
    await expect(
      service.action("s1", goal.id, {
        requestId: "bad-confirm",
        expectedRevision: store.goals.getGoal(goal.id)!.revision,
        action: "confirm",
        questionId: "other",
        objectiveVersion: goal.objectiveVersion,
      }),
    ).rejects.toThrow();
    const input = {
      requestId: "confirm",
      expectedRevision: store.goals.getGoal(goal.id)!.revision,
      action: "confirm" as const,
      objectiveVersion: goal.objectiveVersion,
      questionId: goal.wait?.kind === "user" ? goal.wait.questionId : "",
    };
    const completed = await service.action("s1", goal.id, input);
    expect(completed.status).toBe("completed");
    expect(await service.action("s1", goal.id, input)).toEqual(completed);
    expect(store.goals.getGoal(goal.id)?.revision).toBe(completed.revision);
  });

  it("waits for goal cleanup during edits and preserves ordinary queued user work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let first = true;
    const executed: string[] = [];
    const { service, store, control, admission } = harness(async (store, runId, signal) => {
      executed.push(runId);
      if (first) {
        first = false;
        await gate;
        store.runs.updateRun(runId, {
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
    const ordinary = await admission.admitPromptAndMaybeRun("s1", {
      id: "ordinary",
      items: [{ type: "text", text: "普通问题" }],
    });
    const editInput = { changeKind: "refine" as const, changeReason: "补充目标要求",
      requestId: "edit-once",
      expectedRevision: store.goals.getGoal(goal.id)!.revision,
      objective: "新目标",
    };
    const edit = service.update("s1", goal.id, editInput);
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("paused"));
    expect(store.goals.getGoal(goal.id)?.objective).toBe("旧目标");
    expect(store.runs.getRun(ordinary.run!.id)?.status).toBe("pending");
    release();
    const updated = await edit;
    expect(updated.objective).toBe("新目标");
    await vi.waitFor(() => expect(store.runs.listRuns("s1").every((run) => run.status !== "pending" && run.status !== "running")).toBe(true));
    await drainRuns(store, control);
    expect(executed).toContain(ordinary.run!.id);
    expect(store.runs.getRun(ordinary.run!.id)?.status).toBe("completed");
    expect(
      await service.update("s1", goal.id, editInput),
    ).toEqual(updated);
  });
});
