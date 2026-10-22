import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { GoalModelAttemptService } from "./goal-model-attempt-service.js";

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "p5-goal-gate-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.sessions.create({ id: "session", cwd: directory, model: "m" });
  const goal = store.goals.createGoal({
    sessionId: "session",
    objective: "finish",
    maxAutoTurns: 2,
  });
  store.runs.createRun({
    id: "run",
    sessionId: "session",
    metadata: { goalId: goal.id, goalObjectiveVersion: 1 },
  });
  store.runs.updateRun("run", { status: "running" });
  const events = { checkpoint: () => 0, publishSince: vi.fn() };
  const requestBudgetStop = vi.fn();
  const gate = new GoalModelAttemptService({
    store,
    events,
    requestBudgetStop,
  });
  const scope = {
    agentId: "session",
    sessionId: "session",
    runId: "run",
    inputId: "input",
    traceId: "trace",
    cwd: directory,
    signal: new AbortController().signal,
  };
  const admission = {
    scope,
    generationId: "generation",
    attempt: 1,
    model: "m",
    purpose: "generation" as const,
  };
  return { store, goal, gate, scope, admission, events, requestBudgetStop };
}
const usage = {
  inputTokens: 8,
  outputTokens: 2,
  metering: {
    knownInputTokens: 8,
    knownOutputTokens: 2,
    completeness: "complete" as const,
    inputIncludesCache: true,
    raw: {},
  },
};

describe("GoalModelAttemptService", () => {
  it.each([
    "generation",
    "compaction",
    "finalization",
    "memory",
    "plugin_selection",
  ] as const)(
    "accounts %s once using the durable Run identity",
    async (purpose) => {
      const f = fixture();
      const start = { ...f.admission, purpose };
      await f.gate.beforeDispatch(start);
      const finish = {
        ...start,
        status: "completed" as const,
        usageStatus: "complete" as const,
        usage,
      };
      await f.gate.settle(finish);
      await f.gate.settle(finish);
      expect(f.store.goals.getGoal(f.goal.id)?.usage).toMatchObject({
        knownTokens: 10,
        incomplete: false,
        inFlightAttempts: 0,
      });
    },
  );
  it("rejects a foreign session even for a repeated attempt", async () => {
    const f = fixture();
    await f.gate.beforeDispatch(f.admission);
    await expect(
      f.gate.beforeDispatch({
        ...f.admission,
        scope: { ...f.scope, sessionId: "foreign" },
      }),
    ).rejects.toThrow("不属于");
    await expect(
      f.gate.settle({
        ...f.admission,
        scope: { ...f.scope, sessionId: "foreign" },
        status: "failed",
        usageStatus: "unknown",
      }),
    ).rejects.toThrow("不属于");
  });
  it("refuses a stopped or replaced Goal before dispatch", async () => {
    const f = fixture();
    f.store.goals.updateGoal(f.goal.id, {
      expectedRevision: f.goal.revision,
      status: "paused",
      reason: "用户暂停",
    });
    await expect(f.gate.beforeDispatch(f.admission)).rejects.toThrow(
      "用户暂停",
    );
    expect(f.store.goals.getGoal(f.goal.id)?.usage.inFlightAttempts).toBe(0);
  });
  it("records a durable admission as not dispatched when publishing admission fails", async () => {
    const f = fixture();
    f.events.publishSince.mockImplementationOnce(() => {
      throw new Error("sink failed");
    });
    await expect(f.gate.beforeDispatch(f.admission)).rejects.toThrow(
      "sink failed",
    );
    expect(f.store.goals.getGoal(f.goal.id)?.usage).toMatchObject({
      knownTokens: 0,
      incomplete: false,
      inFlightAttempts: 0,
    });
  });
  it("keeps sent attempts with missing usage unknown and requests the existing stop path", async () => {
    const f = fixture();
    f.store.goals.updateGoal(f.goal.id, {
      expectedRevision: f.goal.revision,
      tokenBudget: 100,
    });
    await f.gate.beforeDispatch(f.admission);
    await f.gate.settle({
      ...f.admission,
      status: "interrupted",
      usageStatus: "unknown",
    });
    expect(f.store.goals.getGoal(f.goal.id)?.usage).toMatchObject({
      incomplete: true,
      unknownAttempts: 1,
    });
    expect(f.requestBudgetStop).toHaveBeenCalledWith(f.goal.id);
  });
  it("does not hide settlement storage failures", async () => {
    const f = fixture();
    await f.gate.beforeDispatch(f.admission);
    vi.spyOn(f.store.goals, "recordGoalModelAttempt").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    await expect(
      f.gate.settle({
        ...f.admission,
        status: "completed",
        usageStatus: "complete",
        usage,
      }),
    ).rejects.toThrow("database unavailable");
  });
});
