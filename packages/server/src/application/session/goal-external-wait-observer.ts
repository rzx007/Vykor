import type { GoalExternalWait, SessionGoal } from "@vykor/protocol";
import type { GoalOperations } from "@vykor/services";
import type { GoalWaitCheck, GoalWaitVerifier } from "./goal-wait-verifier.js";

export type GoalWaitObservationResult = "observe_again" | "settled" | "stopped";

export function sameGoalExternalWait(left: GoalExternalWait, right: GoalExternalWait): boolean {
  return left.goalId === right.goalId && left.objectiveVersion === right.objectiveVersion
    && left.ownerRunId === right.ownerRunId && left.targetRunId === right.targetRunId && left.deadlineAt === right.deadlineAt;
}

/** Timers only: the Goal service owns state changes, transactions and admission. */
export class GoalExternalWaitObserver {
  private readonly waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly deps: {
    goals: Pick<GoalOperations, "getGoal">;
    waitVerifier?: Pick<GoalWaitVerifier, "check">;
    onWaitResult: (goalId: string, expectedWait: GoalExternalWait, check: GoalWaitCheck) => GoalWaitObservationResult;
  }) {}

  observe(goal: SessionGoal, attempt = 0): void {
    const wait = goal.wait;
    if (goal.status !== "active" || wait?.kind !== "external" || !this.deps.waitVerifier) return;
    this.clear(goal.id);
    const delay = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000][Math.min(attempt, 5)]!;
    const timer = setTimeout(() => {
      this.waitTimers.delete(goal.id);
      const current = this.deps.goals.getGoal(goal.id);
      if (!current || current.status !== "active" || current.objectiveVersion !== wait.objectiveVersion
        || current.wait?.kind !== "external" || !sameGoalExternalWait(current.wait, wait)) return;
      const check = this.deps.waitVerifier!.check(current.sessionId, current.wait);
      const result = this.deps.onWaitResult(current.id, current.wait, check);
      if (result === "observe_again") {
        const latest = this.deps.goals.getGoal(goal.id);
        if (latest?.wait?.kind === "external" && sameGoalExternalWait(latest.wait, wait)) this.observe(latest, attempt + 1);
      }
    }, delay);
    timer.unref?.();
    this.waitTimers.set(goal.id, timer);
  }

  clear(goalId: string): void {
    const timer = this.waitTimers.get(goalId);
    if (timer) clearTimeout(timer);
    this.waitTimers.delete(goalId);
  }
}
