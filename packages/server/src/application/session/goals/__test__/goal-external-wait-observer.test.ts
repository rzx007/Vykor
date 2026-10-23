import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "@vykor/domain-contracts/goals";
import { GoalExternalWaitObserver } from "../goal-external-wait-observer.js";

afterEach(() => vi.useRealTimers());
describe("GoalExternalWaitObserver", () => {
  const initial = (): SessionGoal => ({ id: "g", sessionId: "s", objective: "finish", objectiveVersion: 1,
    revision: 0, status: "active", maxAutoTurns: 2, autoTurnsUsed: 0, noProgressCount: 0, evidence: [], createdAt: 1, updatedAt: 1,
    wait: { kind: "external", goalId: "g", objectiveVersion: 1, ownerRunId: "owner", targetRunId: "target", deadlineAt: 100000 } });

  it("backs off without state writes and keeps observing completed results deferred by user work", async () => {
    vi.useFakeTimers();
    let goal = initial();
    const check = vi.fn(() => ({ state: "completed" as const }));
    const onWaitResult = vi.fn(() => "observe_again" as const);
    const observer = new GoalExternalWaitObserver({ goals: { getGoal: () => goal }, waitVerifier: { check }, onWaitResult });
    observer.observe(goal);
    observer.observe(goal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWaitResult).toHaveBeenCalledTimes(1);
    goal = { ...goal, revision: 20 };
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16000 + 30000);
    expect(check).toHaveBeenCalledTimes(6);
    observer.clear(goal.id);
    await vi.advanceTimersByTimeAsync(30000);
    expect(check).toHaveBeenCalledTimes(6);
  });

  it.each(["pause", "change-objective", "change-target"])("drops stale %s callbacks", async (change) => {
    vi.useFakeTimers();
    let goal = initial();
    const onWaitResult = vi.fn(() => "settled" as const);
    const observer = new GoalExternalWaitObserver({ goals: { getGoal: () => goal }, waitVerifier: { check: () => ({ state: "completed" }) }, onWaitResult });
    observer.observe(goal);
    if (change === "pause") goal = { ...goal, status: "paused" };
    if (change === "change-objective") goal = { ...goal, objectiveVersion: 2 };
    if (change === "change-target" && goal.wait?.kind === "external") goal = { ...goal, wait: { ...goal.wait, targetRunId: "different" } };
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWaitResult).not.toHaveBeenCalled();
  });
});
