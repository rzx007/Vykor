import type {
  AppendEventInput,
  SessionEventRecord,
  SessionGoal,
  SessionRecord,
  SessionRunRecord,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import type {
  CreateSessionGoalStoreInput,
  SessionGoalRequestRecord,
  UpdateSessionGoalStoreInput,
} from "./goal-records.js";
import { GoalRepository } from "./goal-repository.js";

export interface GoalOperations {
  createGoal(input: CreateSessionGoalStoreInput): SessionGoal;
  getGoal(id: string): SessionGoal | undefined;
  getCurrentGoal(sessionId: string): SessionGoal | undefined;
  updateGoal(id: string, input: UpdateSessionGoalStoreInput): SessionGoal;
  getGoalRequest(requestId: string): SessionGoalRequestRecord | undefined;
  beginGoalRequest(input: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
  }): SessionGoalRequestRecord;
  settleGoalRequest(
    requestId: string,
    input: {
      status: "pending" | "completed" | "failed";
      goalId?: string;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): SessionGoalRequestRecord;
  recordGoalAssessment(input: {
    goalId: string;
    revision: number;
    runId: string;
    assessment: Record<string, unknown>;
  }): void;
  goalEvidenceSignatures(goalId: string): string[];
  recordGoalContinuation(input: {
    goalId: string;
    revision: number;
    previousRunId: string;
    inputId: string;
    runId: string;
  }): boolean;
  markGoalContinuation(runId: string, status: "dispatched" | "cancelled"): void;
  startGoalRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): boolean;
  finishGoalRun(runId: string): void;
  pauseActiveGoalsOnStartup(): number;
}

export interface GoalTransactionsOptions {
  storage: StorageContext;
  repository: GoalRepository;
  assertSession(sessionId: string): SessionRecord;
  assertMutableSession(session: SessionRecord): void;
  getRun(runId: string): SessionRunRecord | undefined;
  appendEvent(input: AppendEventInput): SessionEventRecord;
}

export class GoalTransactions implements GoalOperations {
  constructor(private readonly options: GoalTransactionsOptions) {}

  getGoal(id: string): SessionGoal | undefined {
    return this.options.repository.getGoal(id);
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    return this.options.repository.getCurrentGoal(sessionId);
  }

  getGoalRequest(requestId: string): SessionGoalRequestRecord | undefined {
    return this.options.repository.getRequest(requestId);
  }

  goalEvidenceSignatures(goalId: string): string[] {
    return this.options.repository.evidenceSignatures(goalId);
  }

  createGoal(input: CreateSessionGoalStoreInput): SessionGoal {
    return this.write(() => {
      const session = this.options.assertSession(input.sessionId);
      this.options.assertMutableSession(session);
      const goal = this.options.repository.insertGoal(input);
      this.emit("session.goal.created", goal);
      return goal;
    });
  }

  updateGoal(id: string, input: UpdateSessionGoalStoreInput): SessionGoal {
    return this.write(() => {
      const goal = this.options.repository.updateGoalRevision(id, input);
      this.emit("session.goal.updated", goal);
      return goal;
    });
  }

  beginGoalRequest(input: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
  }): SessionGoalRequestRecord {
    return this.write(() => this.options.repository.beginRequest(input));
  }

  settleGoalRequest(
    requestId: string,
    input: {
      status: "pending" | "completed" | "failed";
      goalId?: string;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): SessionGoalRequestRecord {
    return this.write(() =>
      this.options.repository.settleRequest(requestId, input),
    );
  }

  recordGoalAssessment(input: {
    goalId: string;
    revision: number;
    runId: string;
    assessment: Record<string, unknown>;
  }): void {
    this.write(() => this.options.repository.recordAssessment(input));
  }

  recordGoalContinuation(input: {
    goalId: string;
    revision: number;
    previousRunId: string;
    inputId: string;
    runId: string;
  }): boolean {
    return this.write(() => this.options.repository.recordContinuation(input));
  }

  markGoalContinuation(
    runId: string,
    status: "dispatched" | "cancelled",
  ): void {
    this.write(() => this.options.repository.markContinuation(runId, status));
  }

  finishGoalRun(runId: string): void {
    this.write(() => {
      const goalId = this.options.repository.findGoalIdByCurrentRun(runId);
      if (!goalId) return;
      this.options.repository.clearCurrentRun(goalId);
      this.emit(
        "session.goal.updated",
        this.options.repository.getGoal(goalId)!,
      );
    });
  }

  startGoalRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): boolean {
    return this.write(() => {
      const goal = this.options.repository.getGoal(goalId);
      if (!goal || goal.status !== "active" || goal.revision !== revision)
        return false;
      const run = this.options.getRun(runId);
      if (
        !run ||
        run.sessionId !== goal.sessionId ||
        (run.status !== "pending" && run.status !== "running")
      )
        return false;
      if (goal.currentRunId === runId) return true;
      if (automatic && goal.autoTurnsUsed >= goal.maxAutoTurns) {
        const paused = this.options.repository.updateGoalRevision(goalId, {
          expectedRevision: revision,
          status: "paused",
          reason: "目标自动续跑额度已用完",
          currentRunId: null,
        });
        this.emit("session.goal.updated", paused);
        return false;
      }
      this.options.repository.bindCurrentRun(
        goalId,
        revision,
        runId,
        automatic,
      );
      this.emit(
        "session.goal.updated",
        this.options.repository.getGoal(goalId)!,
      );
      return true;
    });
  }

  pauseActiveGoalsOnStartup(): number {
    return this.write(() => {
      const goalIds = this.options.repository.listActiveGoalIds();
      for (const id of goalIds) {
        const goal = this.options.repository.getGoal(id)!;
        const paused = this.options.repository.updateGoalRevision(id, {
          expectedRevision: goal.revision,
          status: "paused",
          currentRunId: null,
          reason: "应用重启后需要手动继续",
        });
        this.emit("session.goal.updated", paused);
      }
      this.options.repository.cancelPendingContinuations();
      return goalIds.length;
    });
  }

  private write<T>(work: () => T): T {
    return this.options.storage.atomic(() => {
      this.options.storage.assertWritable();
      return work();
    });
  }

  private emit(
    type: "session.goal.created" | "session.goal.updated",
    goal: SessionGoal,
  ): void {
    this.options.appendEvent({
      type,
      sessionId: goal.sessionId,
      payload: { goal },
    });
  }
}
