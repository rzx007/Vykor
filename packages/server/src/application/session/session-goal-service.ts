import { DEFAULT_GOAL_AUTO_TURNS, MAX_GOAL_AUTO_TURNS, parseGoalUpdateInput, type CreateSessionGoalInput, type GoalActionInput, type GoalExternalWait, type PermissionRequestRecord, type SessionGoal, type SessionRecord, type SessionRunRecord, type UpdateSessionGoalInput } from "@vykor/protocol";
import { goalBudgetStopCode, type GoalOperations } from "@vykor/services";
import { AgentExecutionLimitError } from "@vykor/agent-contracts";
import type { SessionOperationRunner } from "./session-operation-runner.js";
import type { AdmitPromptInput } from "./run-admission-service.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { SessionApplicationError } from "./session-application-error.js";
import type { GoalReadSnapshot } from "../goals/goal-read-tool.js";
import type { GoalWaitCheck, GoalWaitVerifier } from "./goal-wait-verifier.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";
import type { RunAdmissionService } from "./run-admission-service.js";
import type { RunControlService } from "./run-control-service.js";
import { GoalExternalWaitObserver, sameGoalExternalWait, type GoalWaitObservationResult } from "./goal-external-wait-observer.js";
import { emptyPluginScope, readInputPluginScope, type InputPluginScope } from "./session-plugin-selection.js";

export class SessionGoalService {
  private readonly requests = new Map<string, { fingerprint: string; promise: Promise<SessionGoal> }>();
  private readonly admission: Pick<RunAdmissionService, "persistGoalRun" | "persistGoalInput" | "dispatchPersistedRun" | "isRunQueuedOrRunning">;
  private readonly control: Pick<RunControlService, "cancelGoalRuns" | "waitForRuns" | "hasUserWork" | "stopGoalChildren">;
  private readonly waitObserver: GoalExternalWaitObserver;
  constructor(
    private readonly context: {
      transaction: { transaction<T>(work: () => T): T };
      sessions: { get(sessionId: string): SessionRecord | undefined };
      runs: {
        getRun(runId: string): SessionRunRecord | undefined;
        updateRun(runId: string, input: Partial<SessionRunRecord>): SessionRunRecord;
        listRuns(sessionId: string): SessionRunRecord[];
        listGoalRuns(goalId: string, objectiveVersion?: number): SessionRunRecord[];
      };
      permissions: {
        get(requestId: string): PermissionRequestRecord | undefined;
        list(options?: { sessionId?: string; status?: "pending" | "approved" | "denied" | "expired" }): PermissionRequestRecord[];
      };
      goals: GoalOperations;
      operationRunner: Pick<SessionOperationRunner, "run">;
      admission: Pick<RunAdmissionService, "persistGoalRun" | "persistGoalInput" | "dispatchPersistedRun" | "isRunQueuedOrRunning">;
      control: Pick<RunControlService, "cancelGoalRuns" | "waitForRuns" | "hasUserWork" | "stopGoalChildren">;
      events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
      waitVerifier?: Pick<GoalWaitVerifier, "check">;
      pluginCapabilities: Pick<SessionPluginCapabilityService, "admit"> & Partial<Pick<SessionPluginCapabilityService, "captureScope">>;
    },
  ) {
    this.admission = context.admission;
    this.control = context.control;
    this.waitObserver = new GoalExternalWaitObserver({
      goals: context.goals,
      waitVerifier: context.waitVerifier,
      onWaitResult: (goalId, wait, check) => this.settleExternalWait(goalId, wait, check),
    });
  }

  get(sessionId: string): SessionGoal | null {
    this.requireSession(sessionId);
    return this.context.goals.getCurrentGoal(sessionId, true) ?? null;
  }

  checkExecution(goalId: string, objectiveVersion: number): void {
    const before = this.context.events.checkpoint();
    const goal = this.context.goals.getGoal(goalId);
    if (!goal || goal.status !== "active" || goal.objectiveVersion !== objectiveVersion)
      throw new AgentExecutionLimitError("目标已停止或正文版本已变化");
    const result = this.context.goals.checkGoalBudget(goalId);
    this.context.events.publishSince(before);
    if (result.budgetClosed) this.requestBudgetStop(goalId);
    if (result.code) throw new AgentExecutionLimitError(result.code === "token_budget" ? "目标 Token 预算已用完" : "目标用量不完整，有限预算下已停止新增工作");
  }

  checkRunExecution(goalId: string, version: number, runId: string, _boundary: string,
    _tool?: { toolName: string; toolAttemptId: string }): void {
    this.checkExecution(goalId, version);
    const goal = this.context.goals.getGoal(goalId)!;
    const run = this.context.runs.getRun(runId);
    if (!run || run.metadata.goalId !== goalId || run.metadata.goalObjectiveVersion !== version
      || (run.status !== "pending" && run.status !== "running" && !(run.status === "completed" && goal.currentRunId === runId)))
      throw new AgentExecutionLimitError("目标运行身份已变化或运行已停止");
    // A live child may outlast a normally completed parent. Its durable ancestry
    // must still belong to this Goal/version; failed or interrupted parents stop it.
    let ancestor = run;
    const visited = new Set([run.id]);
    while (ancestor.metadata.parentRunId !== undefined) {
      const parentId = ancestor.metadata.parentRunId;
      const parent = typeof parentId === "string" ? this.context.runs.getRun(parentId) : undefined;
      if (!parent || visited.has(parent.id) || visited.size >= 128
        || parent.metadata.goalId !== goalId || parent.metadata.goalObjectiveVersion !== version
        || !["pending", "running", "completed"].includes(parent.status))
        throw new AgentExecutionLimitError("目标子任务的父运行身份已变化或运行已停止");
      visited.add(parent.id);
      ancestor = parent;
    }
    if (ancestor.sessionId !== goal.sessionId)
      throw new AgentExecutionLimitError("目标运行不属于当前目标会话");
  }

  readSnapshot(goalId: string, version: number, runId: string): Promise<GoalReadSnapshot> {
    this.checkRunExecution(goalId, version, runId, "run");
    const goal = this.context.goals.getGoal(goalId)!;
    if (goal.currentRunId !== runId) return Promise.reject(new Error("目标查询所属 Run 已变化"));
    return Promise.resolve({
      goalId, objectiveVersion: version, objective: goal.objective, status: goal.status,
      wait: goal.wait, reason: goal.reason, stopReason: goal.stopReason?.detail ?? goal.stopReason?.code,
      autoTurnsUsed: goal.autoTurnsUsed, maxAutoTurns: goal.maxAutoTurns,
      knownTokens: goal.usage.knownTokens, usageIncomplete: goal.usage.incomplete, tokenBudget: goal.tokenBudget,
    });
  }

  async submitRunUpdate(goalId: string, version: number, runId: string, input: Record<string, unknown>): Promise<{ recorded: true }> {
    this.checkExecution(goalId, version);
    const before = this.context.events.checkpoint();
    try {
      this.context.transaction.transaction(() => {
        const goal = this.context.goals.getGoal(goalId);
        const run = this.context.runs.getRun(runId);
        if (!goal || goal.status !== "active" || goal.objectiveVersion !== version || goal.currentRunId !== runId
          || !run || run.sessionId !== goal.sessionId || run.status !== "running" || run.metadata.goalSettled
          || run.metadata.goalId !== goalId || run.metadata.goalObjectiveVersion !== version)
          throw new SessionApplicationError(409, "目标运行身份或状态已变化");
        if (this.context.permissions.list({ sessionId: goal.sessionId, status: "pending" }).length)
          throw new SessionApplicationError(409, "请先处理未决批准请求");
        const update = parseGoalUpdateInput(input);
        if ("wait" in update) {
          const wait: GoalExternalWait = { kind: "external", ...update.wait, goalId, objectiveVersion: version, ownerRunId: runId };
          if (wait.deadlineAt <= Date.now()) throw new SessionApplicationError(400, "等待期限必须在未来");
          const check = this.context.waitVerifier?.check(goal.sessionId, wait);
          if (!check || check.state === "missing" || check.state === "failed")
            throw new SessionApplicationError(409, "等待的具体任务不存在、归属不符或已失败");
        }
        const saved = run.metadata.goalUpdate;
        if (saved && JSON.stringify(saved) !== JSON.stringify(update))
          throw new SessionApplicationError(409, "本回合已记录控制请求，请正常结束回合后继续");
        this.context.runs.updateRun(runId, { metadata: { goalUpdate: update } });
      });
      return { recorded: true };
    } finally { this.context.events.publishSince(before); }
  }

  /** 事件回调只请求中断，不能等待它所属的 Run 完成。 */
  requestBudgetStop(goalId: string): void {
    const goal = this.context.goals.getGoal(goalId);
    if (!goal) return;
    this.waitObserver.clear(goalId);
    const before = this.context.events.checkpoint();
    const reason = goal.stopReason?.code === "usage_unknown" ? "目标用量不完整，已停止新增工作" : "目标 Token 预算已用完";
    const ids = this.control.cancelGoalRuns(goal.sessionId, goalId, reason);
    this.context.events.publishSince(before);
    void Promise.all([
      this.control.waitForRuns(ids),
      this.control.stopGoalChildren(goal.sessionId, goalId, undefined, reason),
    ]).catch((error) => {
      const current = this.context.goals.getGoal(goalId);
      if (!current || current.status !== "paused" || !["token_budget", "usage_unknown"].includes(current.stopReason?.code ?? "")) return;
      const checkpoint = this.context.events.checkpoint();
      this.context.goals.updateGoal(goalId, {
        expectedRevision: current.revision,
        reason: `${reason}；停止工作尚未完成：${error instanceof Error ? error.message : String(error)}`,
        stopReason: { ...current.stopReason!, detail: error instanceof Error ? error.message : String(error) },
      });
      this.context.events.publishSince(checkpoint);
    });
  }

  recoverExternalWaits(): number {
    const goals = this.context.goals.listActiveExternalWaitGoals();
    for (const goal of goals) this.waitObserver.observe(goal);
    return goals.length;
  }
  getRequest(sessionId: string, requestId: string): ReturnType<GoalOperations["getGoalRequest"]> {
    this.requireSession(sessionId);
    const request = this.context.goals.getGoalRequest(requestId);
    if (!request || request.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal request not found: ${requestId}`);
    return request;
  }
  create(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    let pluginId: string | undefined;
    let pluginScope: InputPluginScope | undefined;
    return this.command(sessionId, input.requestId, { operation: "create", ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const goal = this.context.transaction.transaction(() => {
        const created = this.context.goals.createGoal({
          sessionId, objective: input.objective, pluginId,
          maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS, tokenBudget: input.tokenBudget,
        });
        this.context.goals.beginGoalVersion({ goalId: created.id, objectiveVersion: 1, objective: created.objective,
          requestId: input.requestId, actor: { kind: "local_user" }, createdAt: Date.now() });
        this.persistRun(created, input.requestId, "initial", { ...input, pluginScope });
        return created;
      });
      return this.finishDispatch(input.requestId, goal);
    }, async () => {
      ({ pluginId } = await this.context.pluginCapabilities.admit(this.requireSession(sessionId), input.items ?? []));
      if (!pluginId) pluginScope = await this.context.pluginCapabilities.captureScope?.(this.requireSession(sessionId)) ?? emptyPluginScope();
    });
  }

  update(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    let pluginId: string | undefined;
    let pluginScope: InputPluginScope | undefined;
    return this.command(sessionId, input.requestId, { operation: "update", goalId, ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      let request = this.context.goals.getGoalRequest(input.requestId)!;
      pluginScope ??= readInputPluginScope(request.result?.pluginScope);
      const original = this.requireGoal(sessionId, goalId);
      this.assertOpen(original);
      if (original.revision !== input.expectedRevision && request.result?.phase !== "stopping")
        throw new SessionApplicationError(409, "目标已变化");
      if (input.objective.trim() === original.objective && request.result?.phase !== "stopping") {
        this.context.goals.settleGoalRequest(input.requestId, { status: "completed", goalId, result: { goal: original } });
        return original;
      }
      let paused: SessionGoal;
      if (request.result?.phase === "stopping") {
        paused = original;
        if (paused.revision !== request.result.revision || paused.status !== "paused")
          throw new SessionApplicationError(409, "目标在停止期间已被修改，请重新提交");
      } else {
        paused = this.context.transaction.transaction(() => {
          const changed = this.context.goals.updateGoal(goalId, {
            expectedRevision: input.expectedRevision, status: "paused", currentRunId: null, wait: null,
            reason: "正在更新目标", stopReason: { code: "updating_objective", at: Date.now() },
          });
          this.context.goals.settleGoalRequest(input.requestId, { status: "pending", goalId, result: {
            phase: "stopping", revision: changed.revision, previousStatus: original.status,
            previousReason: original.reason, previousStopReason: original.stopReason,
            ...(pluginScope ? { pluginScope } : {}),
          } });
          return changed;
        });
      }
      this.waitObserver.clear(goalId);
      await this.stopRuns(paused, "目标正文已修改");
      request = this.context.goals.getGoalRequest(input.requestId)!;
      const updated = this.context.transaction.transaction(() => {
        const current = this.requireGoal(sessionId, goalId);
        const budgetCode = goalBudgetStopCode(current, current.usage);
        const keepStopped = request.result?.previousStatus === "paused" || request.result?.previousStatus === "blocked";
        const status = budgetCode ? "paused" : keepStopped ? request.result!.previousStatus as "paused" | "blocked" : "active";
        const goal = this.context.goals.updateGoal(goalId, {
          expectedRevision: paused.revision, objective: input.objective, objectiveVersion: current.objectiveVersion + 1,
          pluginId: pluginId ?? original.pluginId, status, currentRunId: null, wait: null,
          reason: budgetCode ? "已保存新正文；调整预算后请明确继续" : keepStopped && typeof request.result?.previousReason === "string" ? request.result.previousReason : null,
          stopReason: budgetCode ? { code: budgetCode, at: Date.now() } : keepStopped ? request.result?.previousStopReason as SessionGoal["stopReason"] ?? null : null,
        });
        this.context.goals.beginGoalVersion({ goalId, objectiveVersion: goal.objectiveVersion,
          previousVersion: current.objectiveVersion, objective: goal.objective, requestId: input.requestId,
          actor: { kind: "local_user" }, createdAt: Date.now() });
        if (goal.status === "active") this.persistRun(goal, input.requestId, "edit", { ...input, pluginScope });
        else this.context.goals.settleGoalRequest(input.requestId, { status: "completed", goalId, result: { goal, ...(pluginScope ? { pluginScope } : {}) } });
        return goal;
      });
      return updated.status === "active" ? this.finishDispatch(input.requestId, updated) : updated;
    }, async () => {
      ({ pluginId } = await this.context.pluginCapabilities.admit(this.requireSession(sessionId), input.items ?? []));
      if (!pluginId && !this.requireGoal(sessionId, goalId).pluginId)
        pluginScope = await this.context.pluginCapabilities.captureScope?.(this.requireSession(sessionId)) ?? emptyPluginScope();
    });
  }

  action(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    return this.command(sessionId, input.requestId, { operation: "action", goalId, ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const goal = this.requireGoal(sessionId, goalId);
      this.assertOpen(goal);
      if (goal.revision !== input.expectedRevision) throw new SessionApplicationError(409, "目标已变化，请刷新后重试");
      if (input.action === "budget") {
        if (input.tokenBudget !== null && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget! <= 0))
          throw new SessionApplicationError(400, "Token 总预算必须为正整数，或明确解除限制");
        if (input.tokenBudget !== null && input.tokenBudget! < goal.usage.knownTokens)
          throw new SessionApplicationError(409, "总预算不能低于已知用量");
        const saved = this.context.transaction.transaction(() => {
          this.context.goals.updateGoal(goalId, { expectedRevision: goal.revision, tokenBudget: input.tokenBudget });
          const checked = this.context.goals.checkGoalBudget(goalId);
          const changed = this.context.goals.getGoal(goalId)!;
          this.context.goals.settleGoalRequest(input.requestId, { status: "completed", goalId, result: { goal: changed } });
          return { changed, budgetClosed: checked.budgetClosed || (goal.status === "active" && changed.status === "paused" && Boolean(checked.code)) };
        });
        if (saved.budgetClosed) this.requestBudgetStop(goalId);
        return saved.changed;
      }
      const retryRun = input.action === "resume" ? this.waitDispatchCandidate(goal) : undefined;
      if (input.action === "resume") this.validateResume(goal, input, retryRun?.id);
      const updated = this.context.transaction.transaction(() => {
        const changed = this.context.goals.updateGoal(goalId, {
          expectedRevision: input.expectedRevision,
          status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "active",
          maxAutoTurns: goal.maxAutoTurns === 0 ? 0 : goal.maxAutoTurns + (input.action === "resume" ? (input.additionalAutoTurns ?? 0) : 0),
          currentRunId: null,
          reason: null,
          stopReason: input.action === "pause" ? { code: "user_paused", at: Date.now() }
            : input.action === "cancel" ? { code: "user_cancelled", at: Date.now() } : null,
          wait: null,
        });
        if (retryRun) {
          this.context.goals.settleGoalRequest(input.requestId, {
            status: "pending", goalId, result: { goal: changed, runId: retryRun.id, inputId: retryRun.inputId, waitDispatch: true },
          });
        } else if (input.action === "resume")
          this.persistRun(changed, input.requestId, "resume", {
            items: [
              {
                type: "text",
                text: input.response ?? "继续推进目标。",
              },
            ],
            ...(!input.response ? { transcriptVisibility: "hidden" as const } : {}),
          });
        else
          this.context.goals.settleGoalRequest(input.requestId, {
            status: "pending",
            goalId,
            result: { goal: changed, phase: "action-stopping" },
          });
        return changed;
      });
      if (input.action === "resume") return retryRun
        ? this.finishWaitDispatch(input.requestId, updated, retryRun.id) : this.finishDispatch(input.requestId, updated);
      await this.stopRuns(updated, input.action === "cancel" ? "用户取消目标" : "用户停止目标");
      const stopped = this.context.goals.getGoal(goalId)!;
      this.context.goals.settleGoalRequest(input.requestId, {
        status: "completed",
        goalId,
        result: { goal: stopped },
      });
      return stopped;
    });
  }

  async settleRun(sessionId: string, runId: string): Promise<void> {
    const before = this.context.events.checkpoint();
    let nextRunId: string | undefined;
    let waitToObserve: SessionGoal | undefined;
    let budgetClosed = false;
    try {
      this.context.transaction.transaction(() => {
        const run = this.context.runs.getRun(runId);
        if (!run || run.sessionId !== sessionId || run.status === "pending" || run.status === "running" || run.metadata.goalSettled) return;
        const goal = typeof run.metadata.goalId === "string" ? this.context.goals.getGoal(run.metadata.goalId) : undefined;
        if (!goal || goal.sessionId !== sessionId || goal.objectiveVersion !== run.metadata.goalObjectiveVersion || goal.currentRunId !== runId) return;
        this.context.goals.refreshGoalRunTime(goal.id);
        this.context.goals.finishGoalRun(runId);
        this.context.runs.updateRun(runId, { metadata: { goalSettled: true } });
        if (goal.status !== "active") return;
        const budget = this.context.goals.checkGoalBudget(goal.id);
        if (budget.code) { budgetClosed = Boolean(budget.budgetClosed); return; }
        const change = (patch: Omit<Parameters<GoalOperations["updateGoal"]>[1], "expectedRevision">) =>
          this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, currentRunId: null, ...patch });
        if (run.status !== "completed") {
          change({ status: "paused", reason: run.error ?? "目标回合被中断或执行失败",
            stopReason: { code: "run_error", at: Date.now(), runId } });
          return;
        }
        const permission = this.context.permissions.list({ sessionId, status: "pending" })[0];
        if (permission) {
          change({ status: "waiting_user", reason: "目标需要批准后才能继续",
            wait: { kind: "approval", permissionRequestId: permission.id }, stopReason: null });
          return;
        }
        if (this.control.hasUserWork(sessionId)) return;
        const update = run.metadata.goalUpdate === undefined ? undefined : parseGoalUpdateInput(run.metadata.goalUpdate);
        if (update && "status" in update) {
          change({ status: update.status, reason: update.reason, wait: null,
            stopReason: update.status === "paused" ? { code: "user_paused", at: Date.now(), runId } : null });
          return;
        }
        if (update && "question" in update) {
          change({ status: "waiting_user", reason: update.question, stopReason: null,
            wait: { kind: "user", questionId: "goal-question-" + runId, question: update.question, objectiveVersion: goal.objectiveVersion } });
          return;
        }
        if (update && "wait" in update) {
          const wait: GoalExternalWait = { kind: "external", ...update.wait, goalId: goal.id, objectiveVersion: goal.objectiveVersion, ownerRunId: runId };
          const check = this.context.waitVerifier?.check(sessionId, wait);
          if (!check || check.state === "missing" || check.state === "failed") {
            change({ status: "paused", wait: null,
              reason: check?.state === "failed" ? check.reason : "等待的具体任务不存在或归属不符",
              stopReason: { code: check?.state === "failed" ? check.code : "wait_invalid", at: Date.now(), runId } });
          } else {
            waitToObserve = change({ wait, reason: "正在等待任务结果", stopReason: null });
          }
          return;
        }
        if (goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns) {
          change({ status: "paused", reason: "目标自动续跑额度已用完", stopReason: { code: "auto_turn_limit", at: Date.now(), runId } });
          return;
        }
        if (this.context.runs.listRuns(sessionId).some(candidate => candidate.id !== runId && candidate.metadata.goalId === goal.id
          && (candidate.status === "pending" || candidate.status === "running"))) return;
        const continued = change({ reason: null, stopReason: null, wait: null });
        const admitted = this.admission.persistGoalRun(sessionId, this.runInput(continued,
          "goal-" + goal.id + "-" + goal.revision + "-" + runId, "continuation", {
            items: [{ type: "text", text: "继续推进完整目标，依据当前状态检查已做工作并执行下一步。" }], transcriptVisibility: "hidden",
          }));
        if (!this.context.goals.recordGoalContinuation({ goalId: goal.id, revision: continued.revision, previousRunId: runId,
          inputId: admitted.input.id, runId: admitted.run.id })) throw new Error("目标续跑意图已存在");
        nextRunId = admitted.run.id;
      });
      if (budgetClosed) {
        const run = this.context.runs.getRun(runId);
        if (typeof run?.metadata.goalId === "string") this.requestBudgetStop(run.metadata.goalId);
      }
      if (waitToObserve) this.waitObserver.observe(waitToObserve);
      if (nextRunId) {
        this.admission.dispatchPersistedRun(nextRunId);
        this.context.goals.markGoalContinuation(nextRunId, "dispatched");
      }
    } catch (error) {
      const run = this.context.runs.getRun(runId);
      const goal = typeof run?.metadata.goalId === "string" ? this.context.goals.getGoal(run.metadata.goalId) : undefined;
      if (goal?.status === "active" && goal.objectiveVersion === run?.metadata.goalObjectiveVersion) {
        this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", currentRunId: null,
          reason: "目标结算失败，请检查后继续：" + (error instanceof Error ? error.message : String(error)),
          stopReason: { code: "run_error", at: Date.now(), runId: nextRunId ?? runId } });
        this.control.cancelGoalRuns(sessionId, goal.id, "目标结算失败");
      }
    } finally { this.context.events.publishSince(before); }
  }

  private settleExternalWait(goalId: string, expectedWait: GoalExternalWait, check: GoalWaitCheck): GoalWaitObservationResult {
    const before = this.context.events.checkpoint();
    let admittedRunId: string | undefined;
    let budgetClosed = false;
    try {
      const result = this.context.transaction.transaction<GoalWaitObservationResult>(() => {
        const goal = this.context.goals.getGoal(goalId);
        if (!goal || goal.status !== "active" || goal.objectiveVersion !== expectedWait.objectiveVersion
          || goal.wait?.kind !== "external" || !sameGoalExternalWait(goal.wait, expectedWait)) return "stopped";
        const budget = this.context.goals.checkGoalBudget(goalId);
        if (budget.code) { budgetClosed = Boolean(budget.budgetClosed); return "stopped"; }
        if (check.state === "running" || check.state === "unknown") return "observe_again";
        if (check.state !== "completed") {
          this.context.goals.updateGoal(goal.id, {
            expectedRevision: goal.revision, status: "paused", wait: null,
            reason: check.state === "failed" ? check.reason : "等待的外部 Run 不存在或归属不匹配",
            stopReason: { code: check.state === "failed" ? check.code : "wait_invalid", at: Date.now(), runId: expectedWait.targetRunId },
          });
          return "stopped";
        }
        if (this.control.hasUserWork(goal.sessionId) || this.context.runs.listGoalRuns(goal.id, goal.objectiveVersion)
          .some((run) => run.metadata.goalId === goal.id && (run.status === "pending" || run.status === "running"))) return "observe_again";
        const permission = this.context.permissions.list({ sessionId: goal.sessionId, status: "pending" })[0];
        if (permission) {
          this.context.goals.updateGoal(goal.id, {
            expectedRevision: goal.revision, status: "waiting_user", reason: "目标需要批准后才能继续",
            wait: { kind: "approval", permissionRequestId: permission.id }, stopReason: null,
          });
          return "stopped";
        }
        if (goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns) {
          this.context.goals.updateGoal(goal.id, {
            expectedRevision: goal.revision, status: "paused", wait: null, reason: "目标自动续跑额度已用完",
            stopReason: { code: "auto_turn_limit", at: Date.now() },
          });
          return "stopped";
        }
        const continued = this.context.goals.updateGoal(goal.id, {
          expectedRevision: goal.revision, wait: null, reason: null, stopReason: null,
        });
        const inputId = `goal-wait-${goal.id}-${goal.objectiveVersion}-${expectedWait.ownerRunId}-${expectedWait.targetRunId}`;
        const admitted = this.admission.persistGoalRun(goal.sessionId, this.runInput(continued, inputId, "continuation", {
          items: [{ type: "text", text: "等待的外部任务已结束。检查其结果并继续推进目标。" }],
        }));
        this.context.runs.updateRun(admitted.run.id, { metadata: { goalWaitSource: expectedWait } });
        if (!this.context.goals.recordGoalContinuation({
          goalId, revision: continued.revision, previousRunId: `wait:${expectedWait.ownerRunId}:${expectedWait.targetRunId}`,
          inputId: admitted.input.id, runId: admitted.run.id,
        })) throw new Error("目标等待续跑意图已存在");
        admittedRunId = admitted.run.id;
        return "settled";
      });
      if (budgetClosed) this.requestBudgetStop(goalId);
      if (admittedRunId) {
        this.admission.dispatchPersistedRun(admittedRunId);
        this.context.goals.markGoalContinuation(admittedRunId, "dispatched");
      }
      return result;
    } catch (error) {
      // Admission rollback leaves the wait intact. A saved dispatch intent can be resumed explicitly.
      if (!admittedRunId || !this.context.runs.getRun(admittedRunId)) return "observe_again";
      const goal = this.context.goals.getGoal(goalId);
      if (goal?.status === "active" && goal.objectiveVersion === expectedWait.objectiveVersion) {
        this.context.goals.updateGoal(goalId, {
          expectedRevision: goal.revision, status: "paused", reason: `恢复等待目标失败：${error instanceof Error ? error.message : String(error)}`,
          stopReason: { code: "run_error", at: Date.now(), runId: admittedRunId },
        });
      }
      return "stopped";
    } finally {
      this.context.events.publishSince(before);
    }
  }

  private waitDispatchCandidate(goal: SessionGoal): SessionRunRecord | undefined {
    if (goal.stopReason?.code !== "run_error" || !goal.stopReason.runId) return undefined;
    const run = this.context.runs.getRun(goal.stopReason.runId);
    if (!run || !run.inputId || run.sessionId !== goal.sessionId || run.status !== "pending"
      || this.admission.isRunQueuedOrRunning(run.id) || run.metadata.goalId !== goal.id
      || run.metadata.goalObjectiveVersion !== goal.objectiveVersion) return undefined;
    const continuation = this.context.goals.findGoalContinuation(run.id);
    const source = run.metadata.goalWaitSource as GoalExternalWait | undefined;
    if (!continuation || continuation.status !== "pending" || continuation.goalId !== goal.id
      || continuation.inputId !== run.inputId || source?.kind !== "external" || source.goalId !== goal.id
      || source.objectiveVersion !== goal.objectiveVersion
      || this.context.waitVerifier?.check(goal.sessionId, source).state !== "completed") return undefined;
    return run;
  }

  private finishWaitDispatch(requestId: string, goal: SessionGoal, runId: string): SessionGoal {
    try {
      const result = this.finishDispatch(requestId, goal);
      this.context.goals.markGoalContinuation(runId, "dispatched");
      return result;
    } catch (error) {
      this.context.transaction.transaction(() => {
        const current = this.context.goals.getGoal(goal.id)!;
        if (current.status !== "active" || current.objectiveVersion !== goal.objectiveVersion) return;
        const paused = this.context.goals.updateGoal(goal.id, {
          expectedRevision: current.revision, status: "paused", reason: `派发等待续跑失败：${error instanceof Error ? error.message : String(error)}`,
          stopReason: { code: "run_error", at: Date.now(), runId },
        });
        const request = this.context.goals.getGoalRequest(requestId)!;
        this.context.goals.settleGoalRequest(requestId, {
          status: "pending", goalId: goal.id,
          result: { ...request.result, goal: paused, phase: "wait-dispatch-retry", retryRevision: paused.revision },
        });
      });
      throw error;
    }
  }

  private validateResume(goal: SessionGoal, input: GoalActionInput, retryRunId?: string): void {
    if (!["paused", "blocked", "waiting_user"].includes(goal.status)) throw new SessionApplicationError(409, `Goal cannot resume from ${goal.status}`);
    if (goal.maxAutoTurns > 0 && goal.maxAutoTurns + (input.additionalAutoTurns ?? 0) > MAX_GOAL_AUTO_TURNS) throw new SessionApplicationError(400, "自动续跑总额度最多为 1000");
    if (goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns + (input.additionalAutoTurns ?? 0)) throw new SessionApplicationError(409, "请明确增加自动续跑额度");
    if (this.control.hasUserWork(goal.sessionId)) throw new SessionApplicationError(409, "请先等待用户任务结束");
    if (goalBudgetStopCode(goal, goal.usage)) throw new SessionApplicationError(409, "Token 预算已用完或用量不完整，请先调整预算");
    if (input.questionId && (goal.status !== "waiting_user" || goal.wait?.kind !== "user")) throw new SessionApplicationError(409, "目标当前没有等待这个问题的回答");
    if (this.context.runs.listGoalRuns(goal.id).some((run) => run.id !== retryRunId && (run.status === "pending" || run.status === "running"))) throw new SessionApplicationError(409, "目标仍在停止，请稍后继续");
    if (goal.status === "waiting_user") {
      if (goal.wait?.kind === "user" && (!input.response?.trim() || goal.wait.questionId !== input.questionId || goal.wait.objectiveVersion !== input.objectiveVersion)) throw new SessionApplicationError(409, "请先回答当前版本的问题");
      if (goal.wait?.kind === "approval") {
        const request = this.context.permissions.get(goal.wait.permissionRequestId);
        if (request?.sessionId !== goal.sessionId || request.status !== "approved") throw new SessionApplicationError(409, "批准尚未通过，不能恢复目标");
      }
      if (!goal.wait || goal.wait.kind === "external") throw new SessionApplicationError(409, "等待状态尚未解除");
    }
    if (
      this.context.permissions.list({
        sessionId: goal.sessionId,
        status: "pending",
      }).length
    )
      throw new SessionApplicationError(409, "请先处理未决批准请求");
  }
  private command(
    sessionId: string,
    requestId: string,
    payload: Record<string, unknown>,
    work: () => Promise<SessionGoal>,
    preflight?: () => Promise<void>,
  ): Promise<SessionGoal> {
    const fingerprint = JSON.stringify({ sessionId, ...payload });
    const pending = this.requests.get(requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new SessionApplicationError(409, "请求 ID 已用于不同操作"));
      return pending.promise;
    }
    const promise = this.context.operationRunner
      .run(sessionId, async () => {
        try {
          const existing = this.context.goals.getGoalRequest(requestId);
          if (existing && (existing.sessionId !== sessionId || existing.fingerprint !== fingerprint)) {
            throw new Error("session_goal_request_conflict");
          }
          // A durable result already accepted this selection. Only unaccepted attempts
          // need admission; execution still checks the current runtime for every Run.
          if (!existing?.result) await preflight?.();
          this.context.goals.beginGoalRequest({
            requestId,
            sessionId,
            fingerprint,
          });
          return await work();
        } catch (error) {
          const request = this.context.goals.getGoalRequest(requestId);
          if (request?.fingerprint === fingerprint && request.status !== "completed")
            this.context.goals.settleGoalRequest(requestId, {
              status: request.result ? "pending" : "failed",
              goalId: request.goalId,
              result: request.result,
              error: error instanceof Error ? error.message : String(error),
            });
          if (error instanceof Error && (error.message === "session_goal_revision_conflict" || error.message === "session_goal_request_conflict" || error.message.includes("UNIQUE constraint failed"))) throw new SessionApplicationError(409, error.message);
          throw error;
        }
      })
      .finally(() => {
        if (this.requests.get(requestId)?.promise === promise) this.requests.delete(requestId);
      });
    this.requests.set(requestId, { fingerprint, promise });
    return promise;
  }
  private async replay(requestId: string): Promise<SessionGoal | undefined> {
    const request = this.context.goals.getGoalRequest(requestId)!;
    if (request.status === "completed" && request.result?.goal) return request.result.goal as unknown as SessionGoal;
    if (request.result?.phase === "dispatch-retry" && request.goalId && typeof request.result.runId === "string") {
      const goal = this.context.goals.getGoal(request.goalId)!;
      const run = this.context.runs.getRun(request.result.runId);
      if (!run || run.status !== "pending" || goal.status !== "paused" || goal.revision !== request.result.retryRevision
        || run.metadata.goalObjectiveVersion !== goal.objectiveVersion) throw new SessionApplicationError(409, "待派发目标已变化，请刷新后继续");
      this.validateResume(goal, { action: "resume", requestId, expectedRevision: goal.revision }, run.id);
      const active = this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "active", reason: null, stopReason: null });
      return this.finishDispatch(requestId, active);
    }
    if (request.result?.phase === "wait-dispatch-retry" && request.goalId) {
      const goal = this.context.goals.getGoal(request.goalId)!;
      const run = this.waitDispatchCandidate(goal);
      if (goal.revision !== request.result.retryRevision || !run || run.id !== request.result.runId)
        throw new SessionApplicationError(409, "等待续跑状态已变化，请刷新目标");
      this.validateResume(goal, { action: "resume", requestId, expectedRevision: goal.revision }, run.id);
      const active = this.context.transaction.transaction(() => {
        const changed = this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "active", reason: null, stopReason: null });
        this.context.goals.settleGoalRequest(requestId, { status: "pending", goalId: goal.id, result: { ...request.result, goal: changed, phase: undefined } });
        return changed;
      });
      return this.finishWaitDispatch(requestId, active, run.id);
    }
    if (request.result?.phase === "action-stopping" && request.goalId) {
      const goal = this.context.goals.getGoal(request.goalId)!;
      if (goal.revision !== (request.result.goal as SessionGoal).revision) throw new SessionApplicationError(409, "目标在停止期间已经变化，请刷新状态");
      await this.stopRuns(goal, "用户停止目标");
      const stopped = this.context.goals.getGoal(goal.id)!;
      this.context.goals.settleGoalRequest(requestId, {
        status: "completed",
        goalId: goal.id,
        result: { goal: stopped },
      });
      return stopped;
    }
    if (typeof request.result?.runId === "string" && request.goalId) return this.finishDispatch(requestId, this.context.goals.getGoal(request.goalId)!);
    return undefined;
  }

  private persistRun(
    goal: SessionGoal,
    requestId: string,
    kind: string,
    input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
      transcriptVisibility?: "hidden";
      pluginScope?: InputPluginScope;
    },
  ): void {
    this.checkExecution(goal.id, goal.objectiveVersion);
    const admitted = this.admission.persistGoalRun(goal.sessionId, this.runInput(goal, requestId, kind, input));
    this.context.goals.settleGoalRequest(requestId, {
      status: "pending",
      goalId: goal.id,
      result: { ...this.context.goals.getGoalRequest(requestId)?.result, goal, runId: admitted.run.id, inputId: admitted.input.id },
    });
  }
  private runInput(
    goal: SessionGoal,
    requestId: string,
    kind: string,
    input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
      transcriptVisibility?: "hidden";
      pluginScope?: InputPluginScope;
    },
  ): AdmitPromptInput {
    const pluginScope = goal.pluginId ? undefined : input.pluginScope ?? this.savedPluginScope(goal);
    const metadata = {
      goalId: goal.id,
      goalObjectiveVersion: goal.objectiveVersion,
      goalRunKind: kind,
      ...(input.transcriptVisibility ? { transcriptVisibility: input.transcriptVisibility } : {}),
      ...(goal.pluginId ? { pluginId: goal.pluginId } : {}),
      ...(pluginScope ? { pluginScope, pluginSelectionPolicy: pluginScope.source } : {}),
    };
    return {
      id: requestId,
      delivery: "queue",
      items: input.items?.length ? input.items : [{ type: "text", text: goal.objective }],
      attachments: input.attachments,
      metadata,
      runMetadata: metadata,
    };
  }

  /** Continuations reuse durable host evidence, including any narrowed resolved scope. */
  private savedPluginScope(goal: SessionGoal): InputPluginScope {
    const roots = this.context.runs.listGoalRuns(goal.id, goal.objectiveVersion)
      .filter(run => run.sessionId === goal.sessionId && run.metadata.parentRunId === undefined)
      .reverse().sort((left, right) => right.createdAt - left.createdAt);
    for (const run of roots) {
      const selection = run.metadata.pluginSelection as { status?: string; scopeVersion?: number; source?: string;
        pluginIds?: string[]; pluginId?: string | null; version?: string; behaviorDigest?: string } | undefined;
      if (selection?.status === "resolved" && selection.scopeVersion === 2) {
        const scope = readInputPluginScope({ ...selection, source: selection.source === "none" ? "none" : "auto" })!;
        return { scopeVersion: 2, source: scope.source, pluginIds: scope.pluginIds, candidates: scope.candidates };
      }
      if (selection?.status === "resolved" && selection.scopeVersion === undefined && selection.source === "auto") {
        if (selection.pluginId === null) return emptyPluginScope();
        if (typeof selection.pluginId !== "string" || !selection.version || !selection.behaviorDigest)
          throw new Error("旧版目标插件范围缺少来源信息，请重新发送目标");
        return { scopeVersion: 2, source: "auto", pluginIds: [selection.pluginId], candidates: [{
          pluginId: selection.pluginId, displayName: selection.pluginId, description: "",
          version: selection.version, behaviorDigest: selection.behaviorDigest,
        }] };
      }
      const captured = readInputPluginScope(run.metadata.pluginScope);
      if (captured) return captured;
    }
    // A paused objective edit may have a saved scope before its first Run exists.
    const version = this.context.goals.getGoalVersion(goal.id, goal.objectiveVersion);
    const request = version && this.context.goals.getGoalRequest(version.requestId);
    return readInputPluginScope(request?.result?.pluginScope) ?? emptyPluginScope();
  }
  private finishDispatch(requestId: string, goal: SessionGoal): SessionGoal {
    const request = this.context.goals.getGoalRequest(requestId)!;
    const runId = request.result?.runId;
    if (typeof runId !== "string") throw new Error("目标请求缺少持久运行记录");
    const run = this.context.runs.getRun(runId);
    if (!run || run.status === "failed" || run.status === "interrupted" || goal.status !== "active" || run.metadata.goalObjectiveVersion !== goal.objectiveVersion) throw new SessionApplicationError(409, "目标启动已中断，请刷新目标并明确继续");
    this.checkExecution(goal.id, goal.objectiveVersion);
    try { this.admission.dispatchPersistedRun(runId); }
    catch (error) {
      const current = this.context.goals.getGoal(goal.id)!;
      if (current.status === "active" && current.objectiveVersion === goal.objectiveVersion) {
        const paused = this.context.goals.updateGoal(goal.id, { expectedRevision: current.revision, status: "paused", currentRunId: null,
          reason: `目标派发失败：${error instanceof Error ? error.message : String(error)}`,
          stopReason: { code: "run_error", at: Date.now(), runId } });
        this.context.goals.settleGoalRequest(requestId, { status: "pending", goalId: goal.id,
          result: { ...request.result, goal: paused, phase: "dispatch-retry", retryRevision: paused.revision } });
      }
      throw error;
    }
    if (request.result?.waitDispatch) this.context.goals.markGoalContinuation(runId, "dispatched");
    this.context.goals.settleGoalRequest(requestId, {
      status: "completed",
      goalId: goal.id,
      result: { ...request.result, goal },
    });
    return goal;
  }
  private async stopRuns(goal: SessionGoal, reason: string): Promise<void> {
    this.waitObserver.clear(goal.id);
    const before = this.context.events.checkpoint();
    const ids = this.control.cancelGoalRuns(goal.sessionId, goal.id, reason);
    this.context.events.publishSince(before);
    await this.control.waitForRuns(ids);
    await this.control.stopGoalChildren(goal.sessionId, goal.id, goal.objectiveVersion, reason);
    if (this.context.runs.listRuns(goal.sessionId).some((run) => ids.includes(run.id) && (run.status === "pending" || run.status === "running"))) throw new SessionApplicationError(409, "目标尚未停止，请稍后重试");
  }
  private requireSession(sessionId: string): SessionRecord {
    const session = this.context.sessions.get(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    return session;
  }
  private requireGoal(sessionId: string, goalId: string): SessionGoal {
    const goal = this.context.goals.getGoal(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal not found: ${goalId}`);
    return goal;
  }
  private assertOpen(goal: SessionGoal): void {
    if (goal.status === "completed" || goal.status === "cancelled") throw new SessionApplicationError(409, "已结束的目标不能再修改，请新建目标");
  }
}
