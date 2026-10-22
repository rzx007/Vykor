import type { GoalExternalWait } from "@vykor/domain-contracts/goals";
import type { SessionStore } from "@vykor/services";

export type GoalWaitCheck =
  | { state: "running"; checkedAt: number }
  | { state: "completed" }
  | {
      state: "failed";
      code: "external_failed" | "wait_timeout";
      reason: string;
    }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

/** Reads concrete Runs and their trusted parent chain; agent liveness is irrelevant. */
export class GoalWaitVerifier {
  constructor(
    private readonly context: {
      store: Pick<SessionStore, "runs">;
      now?: () => number;
    },
  ) {}

  check(sessionId: string, wait: GoalExternalWait): GoalWaitCheck {
    const now = this.context.now?.() ?? Date.now();
    const timeout = (): GoalWaitCheck => ({
      state: "failed",
      code: "wait_timeout",
      reason: "等待外部任务超时",
    });
    if (
      !wait.targetRunId ||
      !wait.ownerRunId ||
      !wait.goalId ||
      !Number.isSafeInteger(wait.objectiveVersion) ||
      wait.objectiveVersion < 1 ||
      !Number.isSafeInteger(wait.deadlineAt) ||
      wait.deadlineAt <= 0 ||
      wait.targetRunId === wait.ownerRunId
    )
      return { state: "missing" };
    try {
      const get = (id: string) => this.context.store.runs.getRun(id);
      const matches = (run: ReturnType<typeof get>) =>
        run?.metadata.goalId === wait.goalId &&
        run.metadata.goalObjectiveVersion === wait.objectiveVersion;
      const owner = get(wait.ownerRunId);
      if (
        !owner ||
        owner.sessionId !== sessionId ||
        owner.metadata.parentRunId ||
        !matches(owner)
      )
        return { state: "missing" };
      const target = get(wait.targetRunId);
      if (!target || !matches(target)) return { state: "missing" };
      const visited = new Set<string>();
      let current = target;
      while (current.id !== owner.id) {
        if (visited.has(current.id) || visited.size >= 128 || !matches(current))
          return { state: "missing" };
        visited.add(current.id);
        const parentId = current.metadata.parentRunId;
        if (typeof parentId !== "string") return { state: "missing" };
        const parent = get(parentId);
        if (!parent || !matches(parent)) return { state: "missing" };
        current = parent;
      }
      if (target.status === "failed" || target.status === "interrupted")
        return {
          state: "failed",
          code: "external_failed",
          reason: target.error ?? "外部运行未成功完成",
        };
      if (
        target.status === "completed" &&
        target.finishedAt !== undefined &&
        target.finishedAt <= wait.deadlineAt
      )
        return { state: "completed" };
      if (now >= wait.deadlineAt) return timeout();
      if (target.status === "pending" || target.status === "running")
        return { state: "running", checkedAt: now };
      return { state: "unknown", reason: "外部运行缺少可信完成时间" };
    } catch (error) {
      return now >= wait.deadlineAt
        ? timeout()
        : {
            state: "unknown",
            reason: error instanceof Error ? error.message : String(error),
          };
    }
  }
}
