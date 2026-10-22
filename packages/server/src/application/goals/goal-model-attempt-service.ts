import {
  AgentExecutionLimitError,
  type ModelAttemptAdmission,
  type ModelAttemptGate,
  type ModelAttemptSettlement,
  type ModelAttemptIdentity,
} from "@vykor/agent-contracts";
import type { SessionStore } from "@vykor/services";
import type { SessionEventPublisher } from "../session/session-event-publisher.js";

export interface GoalModelAttemptServiceOptions {
  store: Pick<SessionStore, "goals" | "runs">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  requestBudgetStop?(goalId: string): void;
}

/** Admits and accounts actual requests; event projection never writes this ledger. */
export class GoalModelAttemptService implements ModelAttemptGate {
  constructor(private readonly options: GoalModelAttemptServiceOptions) {}

  async beforeDispatch(input: ModelAttemptAdmission): Promise<void> {
    const identity = this.identity(input);
    const before = this.options.events.checkpoint();
    const result = this.options.store.goals.beginGoalModelAttempt({
      ...identity,
      model: input.model,
      provider: input.provider,
      purpose: input.purpose,
    });
    try {
      this.options.events.publishSince(before);
      if (result.budgetClosed && result.goalId)
        this.options.requestBudgetStop?.(result.goalId);
    } catch (error) {
      // Admission was durable, but the caller cannot dispatch after a failed return.
      if (result.allowed)
        this.options.store.goals.recordGoalModelAttempt({
          ...identity,
          status: "failed",
          usageStatus: "unknown",
          notDispatched: true,
        });
      throw error;
    }
    if (!result.allowed) {
      const goal = result.goalId
        ? this.options.store.goals.getGoal(result.goalId)
        : undefined;
      throw new AgentExecutionLimitError(
        goal?.reason ?? "目标执行条件已变化，请查看目标状态",
      );
    }
  }

  async settle(input: ModelAttemptSettlement): Promise<void> {
    const before = this.options.events.checkpoint();
    const result = this.options.store.goals.recordGoalModelAttempt({
      ...this.identity(input),
      status: input.status,
      usageStatus: input.usageStatus,
      metering: input.usage?.metering,
      notDispatched: input.notDispatched,
    });
    this.options.events.publishSince(before);
    if (result.budgetClosed && result.goalId)
      this.options.requestBudgetStop?.(result.goalId);
  }

  private identity(input: ModelAttemptIdentity) {
    const run = this.options.store.runs.getRun(input.scope.runId);
    if (!run || run.sessionId !== input.scope.sessionId) {
      throw new AgentExecutionLimitError("模型尝试不属于当前会话运行");
    }
    return {
      runId: run.id,
      sessionId: run.sessionId,
      generationId: input.generationId,
      attempt: input.attempt,
    };
  }
}
