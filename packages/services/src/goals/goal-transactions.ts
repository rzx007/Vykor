import type {
  AppendEventInput,
  SessionEventRecord,
  SessionGoal,
  SessionRecord,
  SessionRunRecord,
  GoalUsage,
  GoalVersion,
  GoalRequirement,
  GoalAssessment,
  PreparationEpisode,
} from "@vykor/protocol";

import type { StorageContext } from "../database/storage-context.js";
import type {
  CreateSessionGoalStoreInput,
  GoalContinuationRecord,
  SessionGoalRequestRecord,
  UpdateSessionGoalStoreInput,
} from "./goal-records.js";
import { GoalRepository } from "./goal-repository.js";
import {
  assertGoalAttemptKey, getGoalModelAttempt, goalBudgetStopCode, listGoalModelAttempts,
  mergeGoalModelAttempt, saveGoalModelAttempt, summarizeGoalUsage,
  type GoalAttemptStart, type GoalAttemptReport, type GoalBudgetStopCode,
} from "./goal-usage.js";
import { getGoalVersion, beginGoalVersion, appendGoalVersionInput, listGoalVersions, freezeGoalVersionRecord } from "./goal-version.js";

export interface FreezeGoalVersionInput {
  goalId: string; objectiveVersion: number; expectedRevision: number; runId: string; requirements: GoalRequirement[];
}

export interface GoalOperations {
  getGoalVersion(goalId: string, objectiveVersion: number): GoalVersion | undefined;
  beginGoalVersion(input: GoalVersion): GoalVersion;
  appendGoalVersionInput(goalId: string, objectiveVersion: number, inputId: string): void;
  freezeGoalVersion(input: FreezeGoalVersionInput): SessionGoal;
  listGoalVersions(goalId: string): GoalVersion[];
  getPreparationEpisode(episodeId: string): PreparationEpisode | undefined;
  setPreparationEpisode(input: PreparationEpisode): PreparationEpisode;
  reservePreparationTool(episodeId: string, runId: string): void;
  listGoalAssessments(goalId: string, objectiveVersion?: number): GoalAssessment[];
  beginGoalModelAttempt(input: GoalAttemptStart): { allowed: boolean; changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean };
  recordGoalModelAttempt(input: GoalAttemptReport): { changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean };
  refreshGoalRunTime(goalId: string): GoalUsage;
  reconcileGoalModelAttempts(): number;
  checkGoalBudget(goalId: string): { code?: GoalBudgetStopCode; budgetClosed?: boolean };
  createGoal(input: CreateSessionGoalStoreInput): SessionGoal;
  getGoal(id: string): SessionGoal | undefined;
  getCurrentGoal(sessionId: string, includeTerminal?: boolean): SessionGoal | undefined;
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
  findGoalContinuation(runId: string): GoalContinuationRecord | undefined;
  startGoalRun(
    goalId: string,
    objectiveVersion: number,
    runId: string,
    automatic: boolean,
  ): boolean;
  finishGoalRun(runId: string): void;
  listActiveExternalWaitGoals(): SessionGoal[];
  pauseActiveGoalsOnStartup(): number;
}

export interface GoalTransactionsOptions {
  storage: StorageContext;
  repository: GoalRepository;
  assertSession(sessionId: string): SessionRecord;
  assertMutableSession(session: SessionRecord): void;
  getRun(runId: string): SessionRunRecord | undefined;
  listGoalRuns(goalId: string): SessionRunRecord[];
  appendEvent(input: AppendEventInput): SessionEventRecord;
}

export class GoalTransactions implements GoalOperations {
  constructor(private readonly options: GoalTransactionsOptions) {}

  getGoal(id: string): SessionGoal | undefined {
    return this.options.repository.getGoal(id);
  }

  getGoalVersion(goalId: string, objectiveVersion: number): GoalVersion | undefined {
    return getGoalVersion(this.options.storage, goalId, objectiveVersion);
  }

  listGoalVersions(goalId: string): GoalVersion[] {
    return listGoalVersions(this.options.storage, goalId);
  }

  beginGoalVersion(input: GoalVersion): GoalVersion {
    return this.write(() => {
      const existing = this.getGoalVersion(input.goalId, input.objectiveVersion);
      if (!existing) {
        const goal = this.getGoal(input.goalId);
        if (!goal || goal.phase !== "preparing" || goal.objectiveVersion !== input.objectiveVersion || goal.objective !== input.objective)
          throw new Error("goal_version_binding_invalid");
        if (input.objectiveVersion === 1 ? input.previousVersion !== undefined || input.changeKind !== "create"
          : input.previousVersion !== input.objectiveVersion - 1 || !this.getGoalVersion(input.goalId, input.previousVersion) || input.changeKind === "create")
          throw new Error("goal_version_previous_invalid");
      }
      return beginGoalVersion(this.options.storage, input);
    });
  }

  appendGoalVersionInput(goalId: string, objectiveVersion: number, inputId: string): void {
    this.write(() => {
      const version = this.getGoalVersion(goalId, objectiveVersion);
      if (version?.frozenAt !== undefined) throw new Error("goal_version_frozen");
      const goal = this.getGoal(goalId);
      if (!goal || goal.phase !== "preparing" || goal.objectiveVersion !== objectiveVersion) throw new Error("goal_version_binding_invalid");
      appendGoalVersionInput(this.options.storage, goalId, objectiveVersion, inputId);
    });
  }

  freezeGoalVersion(input: FreezeGoalVersionInput): SessionGoal {
    return this.write(() => {
      const goal = this.getGoal(input.goalId);
      const version = this.getGoalVersion(input.goalId, input.objectiveVersion);
      if (!goal || !version || goal.objectiveVersion !== input.objectiveVersion) throw new Error("goal_version_binding_invalid");
      if (version.frozenAt !== undefined) {
        if (goal.phase !== "executing" || JSON.stringify(version.requirements) !== JSON.stringify(input.requirements)) throw new Error("goal_version_frozen");
        return goal;
      }
      if (goal.revision !== input.expectedRevision) throw new Error("session_goal_revision_conflict");
      const episode = goal.preparationEpisodeId ? this.getPreparationEpisode(goal.preparationEpisodeId) : undefined;
      if (goal.status !== "active" || goal.phase !== "preparing" || !episode || episode.goalId !== goal.id
        || episode.objectiveVersion !== goal.objectiveVersion || episode.state !== "ready" || episode.readyRunId !== input.runId
        || (goal.currentRunId !== undefined && goal.currentRunId !== input.runId)) throw new Error("goal_version_freeze_invalid");
      freezeGoalVersionRecord(this.options.storage, input.goalId, input.objectiveVersion, input.requirements);
      const frozen = this.options.repository.updateGoalRevision(goal.id, {
        expectedRevision: input.expectedRevision, phase: "executing", requirements: input.requirements,
        preparationEpisodeId: null, currentRunId: null, wait: null,
      });
      this.emit("session.goal.updated", frozen);
      return frozen;
    });
  }

  getPreparationEpisode(episodeId: string): PreparationEpisode | undefined {
    const request = this.options.repository.getRequest(episodeId);
    return request?.result?.preparation as PreparationEpisode | undefined;
  }

  setPreparationEpisode(input: PreparationEpisode): PreparationEpisode {
    return this.write(() => {
      const request = this.options.repository.getRequest(input.episodeId);
      const goal = this.getGoal(input.goalId);
      const previous = this.getPreparationEpisode(input.episodeId);
      if (!request || !goal || request.sessionId !== goal.sessionId || (request.goalId !== undefined && request.goalId !== input.goalId)
        || goal.objectiveVersion !== input.objectiveVersion || goal.phase !== "preparing"
        || input.inputIds.length > 64 || input.inputIds.some(id => !id.trim() || id.length > 256)
        || new Set(input.inputIds).size !== input.inputIds.length
        || !Number.isSafeInteger(input.modelAttempts) || input.modelAttempts < 0
        || !Number.isSafeInteger(input.readToolCalls) || input.readToolCalls < 0
        || !["accepted", "running", "waiting_user", "ready", "stopped"].includes(input.state)
        || (input.state === "ready" && (!input.readyRunId || input.readyRunId !== input.runId))
        || (previous && (previous.goalId !== input.goalId || previous.objectiveVersion !== input.objectiveVersion
          || input.modelAttempts < previous.modelAttempts || input.readToolCalls < previous.readToolCalls
          || previous.inputIds.some(id => !input.inputIds.includes(id))))
        || (!previous && (input.modelAttempts !== 0 || input.readToolCalls !== 0))) throw new Error("goal_preparation_episode_invalid");
      this.options.repository.settleRequest(input.episodeId, { status: request.status, goalId: input.goalId,
        result: { ...request.result, preparation: input }, ...(request.error ? { error: request.error } : {}) });
      return this.getPreparationEpisode(input.episodeId)!;
    });
  }

  private currentPreparation(episodeId: string, runId: string): { goal: SessionGoal; episode: PreparationEpisode } {
    const episode = this.getPreparationEpisode(episodeId);
    const goal = episode ? this.getGoal(episode.goalId) : undefined;
    const run = this.options.getRun(runId);
    if (!episode || !goal || goal.phase !== "preparing" || goal.status !== "active" || goal.preparationEpisodeId !== episodeId
      || goal.objectiveVersion !== episode.objectiveVersion || goal.currentRunId !== runId || episode.runId !== runId
      || episode.state !== "running" || !run || run.status !== "running" || run.sessionId !== goal.sessionId
      || run.metadata.goalId !== goal.id || run.metadata.goalObjectiveVersion !== goal.objectiveVersion
      || run.metadata.goalPhase !== "preparing" || run.metadata.goalEpisodeId !== episodeId) throw new Error("goal_preparation_run_invalid");
    return { goal, episode };
  }

  reservePreparationTool(episodeId: string, runId: string): void {
    this.write(() => {
      const { episode } = this.currentPreparation(episodeId, runId);
      this.setPreparationEpisode({ ...episode, readToolCalls: episode.readToolCalls + 1 });
    });
  }

  listGoalAssessments(goalId: string, objectiveVersion?: number): GoalAssessment[] {
    return this.options.repository.listAssessments(goalId, objectiveVersion);
  }

  getCurrentGoal(sessionId: string, includeTerminal = false): SessionGoal | undefined {
    return this.options.repository.getCurrentGoal(sessionId, includeTerminal);
  }

  getGoalRequest(requestId: string): SessionGoalRequestRecord | undefined {
    return this.options.repository.getRequest(requestId);
  }

  goalEvidenceSignatures(goalId: string): string[] {
    return this.options.repository.evidenceSignatures(goalId);
  }

  listActiveExternalWaitGoals(): SessionGoal[] {
    return this.options.repository.listActiveExternalWaitGoals();
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
      const current = this.options.repository.getGoal(id);
      const code = current && input.tokenBudget !== undefined && current.status === "active"
        ? goalBudgetStopCode({ tokenBudget: input.tokenBudget ?? undefined }, current.usage) : undefined;
      const goal = this.options.repository.updateGoalRevision(id, code ? {
        ...input, ...this.budgetPauseInput(current!, code),
      } : input);
      if (code) this.options.repository.cancelPendingContinuations([id]);
      this.emit("session.goal.updated", goal);
      return goal;
    });
  }

  beginGoalModelAttempt(input: GoalAttemptStart): { allowed: boolean; changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean } {
    return this.write(() => {
      assertGoalAttemptKey(input);
      const existing = getGoalModelAttempt(this.options.storage, input);
      if (existing) {
        if (existing.sessionId !== input.sessionId || existing.model !== input.model
          || existing.provider !== (input.provider ?? null) || existing.purpose !== input.purpose)
          throw new Error("goal_model_attempt_identity_conflict");
        const goal = this.getGoal(existing.goalId);
        const run = this.options.getRun(input.runId);
        let allowed = Boolean(goal && run && goal.status === "active" && goal.objectiveVersion === existing.objectiveVersion
          && run.metadata.goalId === goal.id && run.metadata.goalObjectiveVersion === goal.objectiveVersion
          && run.metadata.goalPhase === goal.phase && (run.status === "running" || run.status === "completed" && input.purpose === "memory"));
        if (allowed && goal?.phase === "preparing") {
          try { this.currentPreparation(String(run!.metadata.goalEpisodeId), input.runId); } catch { allowed = false; }
        }
        return { allowed, changed: false, goalId: existing.goalId, ...(goal ? { usage: goal.usage } : {}) };
      }
      const run = this.options.getRun(input.runId);
      if (!run || run.sessionId !== input.sessionId) throw new Error("goal_model_attempt_run_invalid");
      if (run.metadata.goalId === undefined) return { allowed: true, changed: false };
      const goalId = run.metadata.goalId;
      const objectiveVersion = run.metadata.goalObjectiveVersion;
      if (typeof goalId !== "string" || !Number.isSafeInteger(objectiveVersion) || (objectiveVersion as number) < 1)
        throw new Error("goal_model_attempt_binding_invalid");
      const goal = this.options.repository.getGoal(goalId);
      if (!goal) throw new Error("goal_model_attempt_goal_missing");
      const closed = this.closeBudget(goal);
      if (closed.code || goal.status !== "active" || goal.objectiveVersion !== objectiveVersion || run.metadata.goalPhase !== goal.phase
        || (run.status !== "running" && !(run.status === "completed" && input.purpose === "memory")))
        return { allowed: false, changed: false, goalId, usage: goal.usage, ...closed };
      if (goal.phase === "preparing") {
        if (typeof run.metadata.goalEpisodeId !== "string") throw new Error("goal_preparation_run_invalid");
        const { episode } = this.currentPreparation(run.metadata.goalEpisodeId, run.id);
        this.setPreparationEpisode({ ...episode, modelAttempts: episode.modelAttempts + 1 });
      }
      saveGoalModelAttempt(this.options.storage, {
        runId: input.runId, generationId: input.generationId, attempt: input.attempt,
        goalId, objectiveVersion: objectiveVersion as number, sessionId: input.sessionId,
        provider: input.provider ?? null, model: input.model, purpose: input.purpose,
        state: "pending", knownInputTokens: 0, knownOutputTokens: 0, inconsistent: false,
        rawUsageJson: null, startedAt: Date.now(), finishedAt: null,
      });
      return { allowed: true, changed: true, goalId, usage: this.refreshUsage(goalId) };
    });
  }

  recordGoalModelAttempt(input: GoalAttemptReport): { changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean } {
    return this.write(() => {
      assertGoalAttemptKey(input);
      const row = getGoalModelAttempt(this.options.storage, input);
      if (!row) {
        const run = this.options.getRun(input.runId);
        if (run?.sessionId === input.sessionId && run.metadata.goalId === undefined) return { changed: false };
        throw new Error("goal_model_attempt_not_registered");
      }
      if (row.sessionId !== input.sessionId) throw new Error("goal_model_attempt_identity_conflict");
      const next = mergeGoalModelAttempt(row, input);
      if (next === row) return { changed: false, goalId: row.goalId, usage: this.options.repository.getGoal(row.goalId)!.usage };
      saveGoalModelAttempt(this.options.storage, next);
      const usage = this.refreshUsage(row.goalId);
      const closed = this.closeBudget(this.options.repository.getGoal(row.goalId)!);
      return { changed: true, goalId: row.goalId, usage, ...(closed.budgetClosed ? { budgetClosed: true } : {}) };
    });
  }

  refreshGoalRunTime(goalId: string): GoalUsage {
    return this.write(() => this.refreshUsage(goalId));
  }

  reconcileGoalModelAttempts(): number {
    return this.write(() => {
      let count = 0;
      for (const row of listGoalModelAttempts(this.options.storage, undefined, false)) {
        const run = this.options.getRun(row.runId);
        if (row.state !== "pending" || (run && (run.status === "pending" || run.status === "running"))) continue;
        saveGoalModelAttempt(this.options.storage, { ...row, state: "unknown", finishedAt: row.finishedAt ?? Date.now() });
        count++;
      }
      for (const id of this.options.repository.listGoalIds(false)) {
        this.refreshUsage(id);
        this.closeBudget(this.options.repository.getGoal(id)!);
      }
      return count;
    });
  }

  checkGoalBudget(goalId: string): { code?: GoalBudgetStopCode; budgetClosed?: boolean } {
    return this.write(() => {
      const goal = this.options.repository.getGoal(goalId);
      if (!goal) throw new Error(`Session goal not found: ${goalId}`);
      return this.closeBudget(goal);
    });
  }

  private refreshUsage(goalId: string): GoalUsage {
    const goal = this.options.repository.getGoal(goalId);
    if (!goal) throw new Error(`Session goal not found: ${goalId}`);
    const next = summarizeGoalUsage(listGoalModelAttempts(this.options.storage, goalId), this.options.listGoalRuns(goalId), goal.usage);
    if (JSON.stringify(next) === JSON.stringify(goal.usage)) return goal.usage;
    const usage = { ...next, seq: goal.usage.seq + 1, updatedAt: Date.now() };
    this.options.repository.updateUsage(goalId, usage);
    this.options.appendEvent({ type: "session.goal.usage.updated", sessionId: goal.sessionId, payload: { goalId, usage } });
    return usage;
  }

  private budgetPauseInput(goal: SessionGoal, code: GoalBudgetStopCode) {
    return { status: "paused" as const, currentRunId: null, wait: null,
      reason: code === "token_budget" ? "目标已达到已知 Token 预算" : "模型用量不完整，需要补账或解除预算后继续",
      stopReason: { code, at: Date.now(), ...(goal.currentRunId ? { runId: goal.currentRunId } : {}),
        detail: [
          `${goal.usage.incomplete ? "至少使用" : "已知使用"} ${goal.usage.knownTokens} Token`,
          goal.assessment?.remainingWork?.length ? `剩余工作（节选）：${goal.assessment.remainingWork.slice(0, 3).map(item => item.slice(0, 256)).join("；")}`
            : goal.assessment ? `最近评估：${goal.assessment.progress.slice(0, 500)}` : "尚无有效评估，恢复后需要重新核对剩余工作",
          "调整总预算或解除限制后，需明确继续；已完成的操作不会回滚",
        ].join("；"),
      } };
  }

  private closeBudget(goal: SessionGoal): { code?: GoalBudgetStopCode; budgetClosed?: boolean } {
    const code = goalBudgetStopCode(goal, goal.usage);
    if (!code) return {};
    if (goal.status !== "active") return { code };
    const paused = this.options.repository.updateGoalRevision(goal.id, {
      expectedRevision: goal.revision, ...this.budgetPauseInput(goal, code),
    });
    this.options.repository.cancelPendingContinuations([goal.id]);
    this.emit("session.goal.updated", paused);
    return { code, budgetClosed: true };
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

  findGoalContinuation(runId: string): GoalContinuationRecord | undefined {
    return this.options.repository.findContinuation(runId);
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
    objectiveVersion: number,
    runId: string,
    automatic: boolean,
  ): boolean {
    return this.write(() => {
      const goal = this.options.repository.getGoal(goalId);
      if (!goal || goal.status !== "active" || goal.objectiveVersion !== objectiveVersion)
        return false;
      const run = this.options.getRun(runId);
      if (
        !run ||
        run.sessionId !== goal.sessionId ||
        (run.status !== "pending" && run.status !== "running")
      )
        return false;
      if (goal.currentRunId === runId) return true;
      const countedAutomatic = automatic && goal.phase === "executing";
      if (countedAutomatic && goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns) {
        const paused = this.options.repository.updateGoalRevision(goalId, {
          expectedRevision: goal.revision,
          status: "paused",
          reason: "目标自动续跑额度已用完",
          stopReason: { code: "auto_turn_limit", at: Date.now(), runId },
          currentRunId: null,
        });
        this.emit("session.goal.updated", paused);
        return false;
      }
      this.options.repository.bindCurrentRun(
        goalId,
        goal.revision,
        runId,
        countedAutomatic,
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
      const pausedGoalIds: string[] = [];
      for (const id of goalIds) {
        const goal = this.options.repository.getGoal(id)!;
        if (goal.wait?.kind === "external") continue;
        const paused = this.options.repository.updateGoalRevision(id, {
          expectedRevision: goal.revision,
          status: "paused",
          currentRunId: null,
          reason: "应用重启后需要手动继续",
          stopReason: { code: "startup_recovery", at: Date.now(), runId: goal.currentRunId },
        });
        this.emit("session.goal.updated", paused);
        pausedGoalIds.push(id);
      }
      this.options.repository.cancelPendingContinuations(pausedGoalIds);
      return pausedGoalIds.length;
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
