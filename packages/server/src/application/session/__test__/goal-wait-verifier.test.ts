import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GoalExternalWait } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { GoalWaitVerifier } from "../goal-wait-verifier.js";

function withRuns(test: (store: SessionStore, wait: GoalExternalWait) => void) {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-wait-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  try {
    for (const id of ["root", "child"]) store.sessions.create({ id, cwd: process.cwd(), model: "m" });
    const goal = store.goals.createGoal({ id: "g", sessionId: "root", objective: "finish", maxAutoTurns: 2 });
    const metadata = { goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion };
    store.runs.createRun({ id: "owner", sessionId: "root", metadata });
    store.runs.updateRun("owner", { status: "completed", finishedAt: 50 });
    store.runs.createRun({ id: "target", sessionId: "child", metadata: { ...metadata, parentRunId: "owner" } });
    store.runs.updateRun("target", { status: "running" });
    test(store, { kind: "external", goalId: goal.id, objectiveVersion: 1, ownerRunId: "owner", targetRunId: "target", deadlineAt: Date.now() + 1000 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

describe("GoalWaitVerifier", () => {
  it("observes the concrete completed Run despite reuse of the child session and a late poll", () => withRuns((store, wait) => {
    store.runs.updateRun("target", { status: "completed", finishedAt: 900 });
    store.runs.createRun({ id: "second", sessionId: "child", metadata: { goalId: "g", goalObjectiveVersion: 1, parentRunId: "owner" } });
    const verifier = new GoalWaitVerifier({ store, now: () => wait.deadlineAt + 1000 });
    expect(verifier.check("root", wait)).toEqual({ state: "completed" });
  }));

  it.each(["goal", "version", "missing-parent", "cycle", "self", "unrelated-owner"])("rejects %s binding", (fault) => withRuns((store, wait) => {
    if (fault === "goal") store.runs.updateRun("target", { metadata: { goalId: "other" } });
    if (fault === "version") store.runs.updateRun("target", { metadata: { goalObjectiveVersion: 2 } });
    if (fault === "missing-parent") store.runs.updateRun("target", { metadata: { parentRunId: "absent" } });
    if (fault === "cycle") store.runs.updateRun("target", { metadata: { parentRunId: "target" } });
    if (fault === "self") wait.targetRunId = "owner";
    if (fault === "unrelated-owner") {
      store.runs.createRun({ id: "other-owner", sessionId: "root", metadata: { goalId: "g", goalObjectiveVersion: 1 } });
      store.runs.updateRun("target", { metadata: { parentRunId: "other-owner" } });
    }
    expect(new GoalWaitVerifier({ store, now: () => 100 }).check("root", wait)).toEqual({ state: "missing" });
  }));

  it.each(["failed", "interrupted"] as const)("checks %s outcomes before deadlines", (status) => withRuns((store, wait) => {
    store.runs.updateRun("target", { status, error: "child stopped" });
    expect(new GoalWaitVerifier({ store, now: () => wait.deadlineAt + 1000 }).check("root", wait))
      .toMatchObject({ state: "failed", code: "external_failed" });
  }));

  it("requires a timely completion timestamp and expires running work", () => withRuns((store, wait) => {
    const verifier = new GoalWaitVerifier({ store, now: () => wait.deadlineAt + 1000 });
    expect(verifier.check("root", wait)).toMatchObject({ state: "failed", code: "wait_timeout" });
    store.runs.updateRun("target", { status: "completed" });
    wait.deadlineAt = store.runs.getRun("target")!.finishedAt! - 1;
    expect(verifier.check("root", wait)).toMatchObject({ state: "failed", code: "wait_timeout" });
  }));

  it("expires unknown reads instead of polling forever", () => withRuns((store, wait) => {
    let now = wait.deadlineAt - 1;
    vi.spyOn(store.runs, "getRun").mockImplementation(() => { throw new Error("read unavailable"); });
    const verifier = new GoalWaitVerifier({ store, now: () => now });
    expect(verifier.check("root", wait)).toMatchObject({ state: "unknown" });
    now = wait.deadlineAt;
    expect(verifier.check("root", wait)).toMatchObject({ state: "failed", code: "wait_timeout" });
  }));

  it("does not accept completion without a recorded completion time", () => withRuns((store, wait) => {
    store.runs.updateRun("target", { status: "completed" });
    const getRun = store.runs.getRun.bind(store.runs);
    vi.spyOn(store.runs, "getRun").mockImplementation((id) => {
      const run = getRun(id);
      if (id === "target" && run) delete run.finishedAt;
      return run;
    });
    let now = wait.deadlineAt - 1;
    const verifier = new GoalWaitVerifier({ store, now: () => now });
    expect(verifier.check("root", wait)).toMatchObject({ state: "unknown" });
    now = wait.deadlineAt;
    expect(verifier.check("root", wait)).toMatchObject({ state: "failed", code: "wait_timeout" });
  }));
});
