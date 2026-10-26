import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VykorAgent } from "@vykor/agent-runtime";
import { readAutoReviewRunMetadata } from "@vykor/domain-contracts/approvals";
import { SessionStore } from "@vykor/services";
import { expect, it } from "vitest";

import { SessionAutoReviewService } from "../../../auto-review/session-auto-review-service.js";
import { SessionEventPublisher } from "../../transcript/session-event-publisher.js";
import { assembleSessionRunServices } from "../session-run-assembly.js";

it("cancels host and admitted model work together and waits for host cleanup and model Goal settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vykor-shared-lane-"));
  const store = new SessionStore({ path: join(dir, "sessions.db") });
  const sessionId = store.sessions.create({ cwd: dir, model: "test-model" }).id;
  const events = new SessionEventPublisher(store.conversations, {
    broadcastSince: () => undefined, broadcastEvent: () => undefined,
  });
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let releaseGoal!: () => void;
  const goal = new Promise<void>((resolve) => { releaseGoal = resolve; });
  let goalStarted!: () => void;
  const settling = new Promise<void>((resolve) => { goalStarted = resolve; });
  const steps: string[] = [];
  const preempted: string[] = [];
  const services = assembleSessionRunServices({
    store, goals: store.goals, agentPool: { configured: true } as never, events,
    assertReady: () => {}, materializeSteerInput: async () => "",
    runExecutor: { execute: async () => { steps.push("model"); } },
    preemptAutoReview: (id) => { preempted.push(id); },
    settleGoalRun: async () => { goalStarted(); await goal; steps.push("goal"); },
  });
  const host = store.runs.createRun({ sessionId });
  let modelId: string | undefined;
  try {
    services.engine.enqueueHostWork({ sessionId, runId: host.id, work: async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      steps.push("host-aborted");
      await cleanup;
      steps.push("host-cleaned");
    } });
    const model = await services.admission.admitPromptAndMaybeRun(sessionId, {
      items: [{ type: "text", text: "queued task" }],
    });
    modelId = model.run!.id;
    expect(model.queue_state).toBe("queued");
    expect(services.control.activeRunId(sessionId)).toBe(host.id);
    expect(services.control.queuedRunIds(sessionId)).toEqual([modelId]);
    expect(preempted).toEqual([sessionId]);
    let hostFinished = false;
    let modelFinished = false;
    const hostWait = services.engine.runtimeBridge.waitForRun(host.id).then(() => { hostFinished = true; });
    const modelWait = services.engine.runtimeBridge.waitForRun(modelId).then(() => { modelFinished = true; });
    expect(services.control.interruptSession(sessionId, "stop mixed work")).toEqual({
      activeRunId: host.id, queuedRunIds: [modelId], interrupted: true,
    });
    await settling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.runs.getRun(modelId)?.status).toBe("interrupted");
    expect(steps).toEqual(["host-aborted"]);
    expect([hostFinished, modelFinished]).toEqual([false, false]);
    releaseCleanup();
    await hostWait;
    expect(modelFinished).toBe(false);
    releaseGoal();
    await modelWait;
    expect(steps).toEqual(["host-aborted", "host-cleaned", "goal"]);
    expect(services.control.hasWork(sessionId)).toBe(false);
  } finally {
    services.engine.runtimeBridge.interruptSession(sessionId);
    releaseCleanup();
    releaseGoal();
    await services.engine.runtimeBridge.waitForRuns([host.id, ...(modelId ? [modelId] : [])]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("lets an accepted user run preempt review and execute in the same session lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vykor-review-lane-"));
  const store = new SessionStore({ path: join(dir, "sessions.db") });
  const sessionId = store.sessions.create({ cwd: dir, model: "test-model" }).id;
  const events = new SessionEventPublisher(store.conversations, {
    broadcastSince: () => undefined,
    broadcastEvent: () => undefined,
  });
  let reviewStarted!: () => void;
  const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
  const executed: string[] = [];
  const autoReview = new SessionAutoReviewService({
    session: store,
    events,
    hasUserWork: (id) => services.control.hasUserWork(id),
    inspector: {
      capture: async () => ({ repositoryRoot: dir, head: "a", dirty: {} }),
      compare: async () => ({
        attribution: "complete", baseHead: "a", head: "a", patchTruncated: false,
        files: [{ path: "src/code.ts", status: "modified", lines: 10 }],
        patch: "diff --git a/src/code.ts b/src/code.ts\n+ changed\n",
      }),
    },
  });
  const agent = {
    runChildForCompletedRun: async (_input: unknown, parent: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        parent.signal.addEventListener("abort", () => resolve(), { once: true });
        reviewStarted();
      });
      return { invocation: { id: "review-child" }, result: { status: "interrupted", output: "" } };
    },
  } as unknown as VykorAgent;
  const services = assembleSessionRunServices({
    store,
    goals: store.goals,
    agentPool: { configured: true } as never,
    events,
    assertReady: () => {},
    materializeSteerInput: async () => "",
    settleGoalRun: async () => {},
    preemptAutoReview: (id) => autoReview.preemptForUserInput(id),
    runExecutor: {
      execute: async (input, context) => {
        executed.push(input.runId);
        store.runs.updateRun(input.runId, { status: "completed" });
        if (executed.length !== 1) return;
        await autoReview.captureBaseline({ ...input, cwd: dir, mode: "risk_based" });
        await autoReview.reviewCompletedRun({ ...input, cwd: dir, traceId: "trace", agent, signal: context.signal });
      },
    },
  });
  try {
    const first = await services.admission.admitPromptAndMaybeRun(sessionId, {
      items: [{ type: "text", text: "first task" }],
    });
    await started;
    const second = await services.admission.admitPromptAndMaybeRun(sessionId, {
      items: [{ type: "text", text: "next task" }],
    });
    await services.engine.runtimeBridge.waitForRuns([first.run!.id, second.run!.id]);
    expect(executed).toEqual([first.run!.id, second.run!.id]);
    expect(readAutoReviewRunMetadata(store.runs.getRun(first.run!.id)?.metadata.autoReview))
      .toMatchObject({ status: "skipped", reasons: ["review_preempted_by_user"] });
    expect(store.runs.getRun(first.run!.id)?.status).toBe("completed");
    expect(store.runs.getRun(second.run!.id)?.status).toBe("completed");
  } finally {
    autoReview.preemptForUserInput(sessionId);
    await services.engine.runtimeBridge.waitForRuns(executed);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
