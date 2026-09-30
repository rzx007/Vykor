import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VykorAgent } from "@vykor/agent-runtime";
import { readAutoReviewRunMetadata } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { expect, it } from "vitest";

import { SessionAutoReviewService } from "../../auto-review/session-auto-review-service.js";
import { SessionEventPublisher } from "../session-event-publisher.js";
import { assembleSessionRunServices } from "../session-run-assembly.js";

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
