import type { SessionGoal } from "@vykor/protocol";
import type { GoalOperations } from "@vykor/services";
import type { GoalWaitVerifier } from "./goal-wait-verifier.js";
import type { RunAdmissionService, AdmitPromptInput } from "./run-admission-service.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export class GoalExternalWaitObserver {
  private readonly waitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: {
    goals: Pick<GoalOperations, "getGoal" | "updateGoal" | "recordGoalContinuation" | "markGoalContinuation">;
    admission: Pick<RunAdmissionService, "persistGoalRun" | "dispatchPersistedRun">;
    events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
    waitVerifier?: Pick<GoalWaitVerifier, "check">;
    runInput: (goal: SessionGoal, requestId: string, kind: string, input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
      transcriptVisibility?: "hidden";
    }) => AdmitPromptInput;
  }) {}

  observe(goal: SessionGoal, attempt = 0): void {
    const wait = goal.wait;
    if (wait?.kind !== "external" || !this.deps.waitVerifier) return;
    this.clear(goal.id);
    const delay = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000][Math.min(attempt, 5)]!;
    const timer = setTimeout(() => {
      this.waitTimers.delete(goal.id);
      const current = this.deps.goals.getGoal(goal.id);
      if (!current || current.status !== "active" || current.revision !== goal.revision || current.wait?.kind !== "external" || current.wait.handleId !== wait.handleId) return;
      const check = this.deps.waitVerifier!.check(current.sessionId, current.wait);
      if (check.state === "running" || check.state === "unknown") {
        this.observe(current, attempt + 1);
        return;
      }
      const before = this.deps.events.checkpoint();
      try {
        if (check.state !== "completed") {
          this.deps.goals.updateGoal(current.id, {
            expectedRevision: current.revision,
            status: "paused",
            wait: null,
            reason: check.state === "failed" ? check.reason : "等待的外部任务不存在或不属于当前会话",
          });
          return;
        }
        const continued = this.deps.goals.updateGoal(current.id, {
          expectedRevision: current.revision,
          status: "active",
          wait: null,
          reason: null,
        });
        const inputId = `goal-wait-${continued.id}-${continued.revision}-${wait.handleId}`;
        const admitted = this.deps.admission.persistGoalRun(
          continued.sessionId,
          this.deps.runInput(continued, inputId, "continuation", {
            items: [
              {
                type: "text",
                text: "等待的外部任务已结束。检查其结果并继续推进目标。",
              },
            ],
          }),
        );
        if (
          this.deps.goals.recordGoalContinuation({
            goalId: continued.id,
            revision: continued.revision,
            previousRunId: `wait:${wait.runId}:${wait.handleId}`,
            inputId: admitted.input.id,
            runId: admitted.run.id,
          })
        ) {
          this.deps.admission.dispatchPersistedRun(admitted.run.id);
          this.deps.goals.markGoalContinuation(admitted.run.id, "dispatched");
        }
      } catch (error) {
        const failed = this.deps.goals.getGoal(goal.id);
        if (failed?.status === "active") {
          this.deps.goals.updateGoal(failed.id, {
            expectedRevision: failed.revision,
            status: "paused",
            wait: null,
            reason: `恢复等待目标失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } finally {
        this.deps.events.publishSince(before);
      }
    }, delay);
    timer.unref?.();
    this.waitTimers.set(goal.id, timer);
  }

  clear(goalId: string): void {
    const timer = this.waitTimers.get(goalId);
    if (!timer) return;
    clearTimeout(timer);
    this.waitTimers.delete(goalId);
  }
}
