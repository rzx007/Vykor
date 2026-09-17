import type { GoalWait } from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";

export type GoalWaitCheck =
  | { state: "running"; checkedAt: number }
  | { state: "completed" }
  | { state: "failed"; reason: string }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

export class GoalWaitVerifier {
  constructor(
    private readonly context: {
      store: Pick<SessionStore, "runs">;
      liveChildren: Pick<LiveChildAgentDirectory, "resolveRootSessionId">;
      now?: () => number;
    },
  ) {}

  check(
    sessionId: string,
    wait: Extract<GoalWait, { kind: "external" }>,
  ): GoalWaitCheck {
    const now = this.context.now?.() ?? Date.now();
    if (now >= wait.deadlineAt)
      return { state: "failed", reason: "等待外部任务超时" };
    try {
      const run = this.context.store.runs.getRun(wait.handleId);
      if (run) {
        if (run.sessionId !== sessionId) return { state: "missing" };
        if (run.status === "pending" || run.status === "running")
          return { state: "running", checkedAt: now };
        return run.status === "completed"
          ? { state: "completed" }
          : { state: "failed", reason: run.error ?? "外部运行未成功完成" };
      }
      return this.context.liveChildren.resolveRootSessionId(wait.handleId) ===
        sessionId
        ? { state: "running", checkedAt: now }
        : { state: "missing" };
    } catch (error) {
      return {
        state: "unknown",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
