import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { DaemonOperationGate } from "../../../control/daemon-operation-gate.js";
import { SessionGoalService } from "../session-goal-service.js";
import { SessionOperationRunner } from "../../session-operation-runner.js";
import { SessionInteractionService } from "../../interactions/session-interaction-service.js";
import { assembleSessionRunServices } from "../../execution/session-run-assembly.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "vk-queue-integration-"));
  const store = new SessionStore({ path: join(dir, "db") });
  store.sessions.create({ id: "s", cwd: dir, model: "test" });
  const created = store.goals.createGoal({ sessionId: "s", objective: "完整目标", maxAutoTurns: 10 });
  store.goals.updateGoal(created.id, { expectedRevision: created.revision, status: "paused" });
  const events = { checkpoint: () => store.conversations.latestEventSeq(), publishSince: () => {} };
  const operationGate = new DaemonOperationGate();
  const runner = new SessionOperationRunner({ sessions: store.sessions, events, operationGate });
  const releases = new Map<string, ReturnType<typeof deferred>>();
  const started = new Map<string, ReturnType<typeof deferred>>();
  let goals!: SessionGoalService;
  const services = assembleSessionRunServices({
    store, goals: store.goals, agentPool: { configured: true } as never, events,
    assertReady: () => {}, materializeSteerInput: async () => "",
    settleGoalRun: (id, runId) => goals.settleRun(id, runId),
    settleQueuedGoalResume: (id, failed) => goals.settleQueuedResume(id, failed),
    checkGoalExecution: (id, version) => goals.checkExecution(id, version),
    runExecutor: { execute: async ({ runId }) => {
      const run = store.runs.getRun(runId)!;
      store.runs.updateRun(runId, { status: "running" });
      started.get(run.inputId!)?.resolve();
      await releases.get(run.inputId!)?.promise;
      store.runs.updateRun(runId, { status: "completed" });
      // Keep successful Goal runs from auto-continuing forever in this fixture.
      if (run.metadata.goalId) store.goals.updateGoal(created.id, {
        expectedRevision: store.goals.getGoal(created.id)!.revision, status: "paused",
      });
    } },
  });
  goals = new SessionGoalService({
    transaction: store, sessions: store.sessions, runs: store.runs, goals: store.goals, conversations: store.conversations,
    permissions: store.permissions, events, operationRunner: runner,
    admission: services.admission, control: services.control,
    pluginCapabilities: { admit: async () => ({}) },
  });
  const current = () => store.goals.getGoal(created.id)!;
  const resumeRuns = () => store.runs.listGoalRuns(created.id).filter(run => run.metadata.goalRunKind === "resume");
  const user = async (id: string) => {
    const gate = deferred(); releases.set(id, gate);
    const begun = deferred(); started.set(id, begun);
    const result = await services.admission.admitPromptAndMaybeRun("s", { id, items: [{ type: "text", text: id }] });
    await begun.promise;
    return { runId: result.run!.id, release: () => gate.resolve() };
  };
  cleanups.push(async () => {
    await goals.action("s", created.id, { action: "cancel_resume", requestId: "cleanup", expectedRevision: current().revision });
    for (const gate of releases.values()) gate.resolve();
    await services.engine.runtimeBridge.waitForRuns(store.runs.listRuns("s").map(run => run.id));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, services, runner, operationGate, goals, current, resumeRuns, user };
}

it.each([0, 3, 5, 8, 12])("consumes a queued resume once when its client retries during completion (delay %s)", async delay => {
  const h = await harness(); const user = await h.user("supplement");
  const request = { action: "resume" as const, requestId: "queued", expectedRevision: h.current().revision };
  await h.goals.action("s", h.current().id, request);
  user.release();
  let interleave = Promise.resolve();
  for (let turn = 0; turn < delay; turn++) interleave = interleave.then(() => {});
  await interleave.then(() => h.goals.action("s", h.current().id, request));
  await h.services.engine.runtimeBridge.waitForRun(user.runId);
  expect(h.goals.get("s")?.queuedResume).toBeUndefined();
  expect(h.resumeRuns()).toHaveLength(1);
});

it("replays a completed resume despite a later failed preparation without dispatching again", async () => {
  const h = await harness();
  const request = { action: "resume" as const, requestId: "completed", expectedRevision: h.current().revision };
  const accepted = await h.goals.action("s", h.current().id, request);
  await h.services.engine.runtimeBridge.waitForRuns(h.resumeRuns().map(run => run.id));
  const preparing = deferred();
  const sending = h.services.admission.withUserInputPreparation("s", () => preparing.promise).catch(() => {});
  const replay = h.goals.action("s", h.current().id, request);
  preparing.reject(new Error("later preparation failed"));
  await sending;
  expect(await replay).toEqual(accepted);
  expect(h.resumeRuns()).toHaveLength(1);
});

it.each([[false, false], [true, false], [false, true], [true, true]])("tracks supplemental preparation (failure=%s, resume arrives during preparation=%s)", async (failed, resumeDuringPreparation) => {
  const h = await harness(); const user = await h.user("first");
  if (!resumeDuringPreparation) await h.goals.action("s", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision });
  const preparing = deferred(); const entered = deferred();
  const interactions = new SessionInteractionService({
    sessions: h.store.sessions, conversations: h.store.conversations, runs: h.store.runs,
    admission: h.services.admission, control: h.services.control, operationRunner: h.runner,
    operationGate: h.operationGate, agentPool: { configured: true, close: async () => {}, warm: async () => {} },
    liveChildren: { has: () => false, send: async () => undefined, interrupt: async () => false },
    pluginCapabilities: { admit: async () => ({}), captureScope: async () => {
      entered.resolve(); await preparing.promise;
      return { scopeVersion: 2, source: "none", pluginIds: [], candidates: [] };
    } },
  });
  const sending = interactions.admitPrompt("s", { id: "second", items: [{ type: "text", text: "新的约束" }] })
    .then(() => undefined, error => error.message);
  await entered.promise;
  const continuing = resumeDuringPreparation
    ? h.goals.action("s", h.current().id, { action: "resume", requestId: "queued", expectedRevision: h.current().revision })
      .then(() => undefined, error => error.message)
    : Promise.resolve(undefined);
  expect(h.services.control.hasUserWork("s")).toBe(true);
  user.release();
  // Wait for the previous execution to settle while the new preparation still owns the operation lane.
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  expect(h.resumeRuns()).toHaveLength(0);
  if (failed) preparing.reject(new Error("plugin preparation failed")); else preparing.resolve();
  expect(await sending).toBe(failed ? "plugin preparation failed" : undefined);
  expect(await continuing).toBe(failed && resumeDuringPreparation ? "补充消息未正常完成，请检查后重新继续目标。" : undefined);
  await h.services.engine.runtimeBridge.waitForRun(user.runId);
  if (!failed) {
    const second = h.store.runs.findRunByInput("second")!;
    await h.services.engine.runtimeBridge.waitForRun(second.id);
  }
  // Completion callbacks may notify after the outer admission promise resolves.
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  expect(h.goals.get("s")?.queuedResume).toBeUndefined();
  expect(h.resumeRuns()).toHaveLength(failed ? 0 : 1);
  expect(h.services.admission.hasPendingAdmission("s")).toBe(false);
  if (failed && resumeDuringPreparation) {
    await h.goals.action("s", h.current().id, { action: "resume", requestId: "explicit-retry", expectedRevision: h.current().revision });
    expect(h.resumeRuns()).toHaveLength(1);
  }
});
