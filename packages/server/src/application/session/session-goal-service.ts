import { DEFAULT_GOAL_AUTO_TURNS, MAX_GOAL_AUTO_TURNS, parseGoalAssessment, type GoalRequirement, type PreparationEpisode, type GoalVersion, type SessionInputRecord, type CreateSessionGoalInput, type GoalActionInput, type GoalAssessment, type GoalExternalWait, type PermissionRequestRecord, type SessionGoal, type SessionMessagePartRecord, type SessionMessageRecord, type SessionRecord, type SessionRunRecord, type UpdateSessionGoalInput } from "@vykor/protocol";
import { goalBudgetStopCode, type GoalOperations } from "@vykor/services";
import { AgentExecutionLimitError } from "@vykor/core";
import type { SessionOperationRunner } from "./session-operation-runner.js";
import type { AdmitPromptInput } from "./run-admission-service.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { SessionApplicationError } from "./session-application-error.js";
import { classifyGoalCompletion, requirementEvidenceSatisfied, validateRequirementCoverage } from "./goal-assessment-policy.js";
import { readGoalEvidence, readGoalDiagnostics, goalEvidenceRejection } from "./goal-evidence-reader.js";
import { evaluateGoalProgress, isWaitingGoalAssessment } from "./goal-progress-policy.js";
import type { GoalReadSnapshot, GoalAssessmentFeedback } from "@vykor/agent-runtime";
import type { GoalWaitCheck, GoalWaitVerifier } from "./goal-wait-verifier.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";
import type { RunAdmissionService } from "./run-admission-service.js";
import type { RunControlService } from "./run-control-service.js";
import { GoalExternalWaitObserver, sameGoalExternalWait, type GoalWaitObservationResult } from "./goal-external-wait-observer.js";

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
      conversations: {
        getInput(inputId: string): SessionInputRecord | undefined | null;
        listMessages(sessionId: string): SessionMessageRecord[];
        listMessageParts(sessionId: string): SessionMessagePartRecord[];
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
      pluginCapabilities: Pick<SessionPluginCapabilityService, "admit">;
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

  checkRunExecution(goalId: string, version: number, runId: string, boundary: string,
    tool?: { toolName: string; toolAttemptId: string }): void {
    this.checkExecution(goalId, version);
    const goal = this.context.goals.getGoal(goalId)!;
    const run = this.context.runs.getRun(runId);
    if (!run || run.metadata.goalPhase !== goal.phase || (goal.phase === "preparing" && run.metadata.goalEpisodeId !== goal.preparationEpisodeId))
      throw new AgentExecutionLimitError("目标阶段或准备批次已变化");
    if (goal.phase !== "preparing") return;
    if (boundary === "child" || boundary === "maintenance") throw new AgentExecutionLimitError("准备阶段不开放子任务或维护");
    if (boundary === "tool" && tool && !["GoalRead", "GoalAssessment"].includes(tool.toolName)) {
      if (!["Read", "Glob", "Grep"].includes(tool.toolName)) throw new AgentExecutionLimitError("准备只允许只读调查");
      this.context.goals.reservePreparationTool(goal.preparationEpisodeId!, runId);
    }
  }

  readSnapshot(goalId: string, version: number, runId: string): Promise<GoalReadSnapshot> {
    this.checkRunExecution(goalId, version, runId, "run");
    const goal = this.context.goals.getGoal(goalId)!;
    if (goal.currentRunId !== runId) return Promise.reject(new Error("目标查询所属 Run 已变化"));
    const definition = this.context.goals.getGoalVersion(goalId, version);
    if (!definition) return Promise.reject(new Error("目标版本记录缺失"));
    const messages = new Set(this.context.conversations.listMessages(goal.sessionId).filter(item => item.runId === runId).map(item => item.id));
    const recentEvidence = this.context.conversations.listMessageParts(goal.sessionId)
      .filter(part => messages.has(part.messageId) && part.type === "tool" && part.status === "completed" && !part.isError && part.output != null
        && part.metadata.executionState === "completed" && part.toolName && !["GoalRead", "GoalAssessment"].includes(part.toolName))
      .slice(-32).map(part => ({ messagePartId: part.id, runId, toolName: part.toolName!,
        ...(typeof part.input?.command === "string" ? { command: part.input.command.slice(0, 1000) } : {}),
        ...(typeof part.input?.workdir === "string" ? { workdir: part.input.workdir.slice(0, 500) } : {}) }));
    return Promise.resolve({ goalId, objectiveVersion: version, phase: goal.phase, objective: goal.objective,
      sourceInputIds: definition.inputIds,
      requirements: goal.requirements.map(item => ({ id: item.id, text: item.text, constraints: item.constraints,
        verification: JSON.stringify(item.verification),
        status: goal.assessment?.requirements?.find(value => value.requirementId === item.id)?.status ?? "incomplete" })),
      latestAssessment: goal.assessment?.progress, waitSummary: goal.reason,
      stopReason: goal.stopReason?.detail, autoTurnsUsed: goal.autoTurnsUsed, maxAutoTurns: goal.maxAutoTurns,
      knownTokens: goal.usage.knownTokens, usageIncomplete: goal.usage.incomplete, recentEvidence });
  }

  /** Same evidence rules as settlement, allowing only this still-running root for preflight. */
  async reviewAssessment(goalId: string, version: number, runId: string, input: Record<string, unknown>): Promise<GoalAssessmentFeedback> {
    const snapshot = await this.readSnapshot(goalId, version, runId);
    const goal = this.context.goals.getGoal(goalId)!;
    let assessment: GoalAssessment;
    try {
      assessment = parseGoalAssessment(input, { goalId, objectiveVersion: version, runId, phase: goal.phase });
      validateRequirementCoverage(goal.requirements, assessment.requirements);
    } catch (error) {
      return { issues: [`评估格式或条件覆盖不完整：${error instanceof Error ? error.message : String(error)}`], availableEvidence: snapshot.recentEvidence };
    }
    const evidence = readGoalEvidence(this.context, goal, assessment, { preview: true });
    const evidenceIssues: NonNullable<GoalAssessmentFeedback["evidenceIssues"]> = [];
    const issues = (assessment.requirements ?? []).flatMap(report => {
      const requirement = goal.requirements.find(item => item.id === report.requirementId)!;
      if (report.status !== "satisfied" || requirement.verification.kind === "user_acceptance"
        || requirementEvidenceSatisfied(goal, assessment, evidence, report.requirementId)) return [];
      if (!report.evidenceRefs.length) return [`${report.requirementId}: 已满足的客观条件缺少证据引用。`];
      return report.evidenceRefs.filter(ref => !evidence.some(item => item.requirementId === report.requirementId
        && item.supportsCompletion !== false && item.origin.goalId === ref.goalId && item.origin.runId === ref.runId
        && item.origin.objectiveVersion === ref.objectiveVersion && item.origin.messagePartId === ref.messagePartId))
        .map(ref => {
          const issue = goalEvidenceRejection(this.context, goal, assessment, requirement, ref);
          evidenceIssues.push(issue);
          return `[${issue.code}] ${issue.requirementId} / ${issue.messagePartId}: ${issue.message}`;
        });
    });
    const progress = evaluateGoalProgress({ goal, assessment, evidence, diagnostics: [],
      history: this.context.goals.listGoalAssessments(goal.id, version) });
    for (const signal of isWaitingGoalAssessment(assessment) ? [] : assessment.progressSignals ?? []) {
      const origins = progress.verifiedSignals.filter(item => item.requirementId === signal.requirementId && item.kind === signal.kind).flatMap(item => item.origins);
      if (!signal.evidenceRefs.every(ref => origins.some(origin => origin.goalId === ref.goalId && origin.runId === ref.runId
          && origin.objectiveVersion === ref.objectiveVersion && origin.messagePartId === ref.messagePartId)))
        issues.push(`${signal.requirementId}: 进展声明 ${signal.kind} 的引用 [${signal.evidenceRefs.map(ref => ref.messagePartId).join(", ")}] 无效或没有证明新增变化。请修正声明；已有有效结果无需重跑。`);
    }
    return { issues, evidenceIssues, availableEvidence: snapshot.recentEvidence };
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
    return this.command(sessionId, input.requestId, { operation: "create", ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const goal = this.context.transaction.transaction(() => {
        const created = this.context.goals.createGoal({
          sessionId,
          objective: input.objective,
          pluginId,
          maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS,
          tokenBudget: input.tokenBudget,
        });
        return this.prepare(created, input.requestId, input, { changeKind: "create", changeReason: "用户创建目标" });
      });
      return this.finishDispatch(input.requestId, goal);
    }, async () => {
      ({ pluginId } = await this.context.pluginCapabilities.admit(this.requireSession(sessionId), input.items ?? []));
    });
  }
  update(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    let pluginId: string | undefined;
    return this.command(sessionId, input.requestId, { operation: "update", goalId, ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      if (!input.changeReason?.trim() || !["refine", "pivot"].includes(input.changeKind)) throw new SessionApplicationError(400, "请选择变更类型并说明原因");
      const request = this.context.goals.getGoalRequest(input.requestId)!;
      const original = this.requireGoal(sessionId, goalId);
      if (original.revision !== input.expectedRevision && request.result?.phase !== "stopping") throw new SessionApplicationError(409, "目标已变化");
      const hasNewSources = Boolean(input.attachments?.length || input.items?.some(item => item.type !== "text" || item.text.trim() !== original.objective));
      if (input.objective.trim() === original.objective && !(input.replaceRequirementIds?.length) && !hasNewSources) {
        this.context.goals.settleGoalRequest(input.requestId, { status: "completed", goalId, result: { goal: original, noChange: true } });
        return original;
      }
      if (input.replaceRequirementIds?.some(id => !original.requirements.some(item => item.id === id))) throw new SessionApplicationError(400, "替换项不属于当前条件");
      let paused: SessionGoal;
      if (request.result?.phase === "stopping") {
        pluginId = typeof request.result.pluginId === "string" ? request.result.pluginId : undefined;
        paused = this.requireGoal(sessionId, goalId);
        if (paused.revision !== request.result.revision || paused.status !== "paused") throw new SessionApplicationError(409, "目标在停止期间已被修改，请重新提交");
      } else {
        this.assertOpen(this.requireGoal(sessionId, goalId));
        paused = this.context.transaction.transaction(() => {
          const changed = this.context.goals.updateGoal(goalId, {
            expectedRevision: input.expectedRevision,
            status: "paused",
            reason: "正在更新目标",
            stopReason: { code: "updating_objective", at: Date.now() },
          });
          this.context.goals.settleGoalRequest(input.requestId, {
            status: "pending",
            goalId,
            result: { phase: "stopping", revision: changed.revision, pluginId: pluginId ?? changed.pluginId },
          });
          return changed;
        });
      }
      await this.stopRuns(paused, "目标正文已修改");
      const updated = this.context.transaction.transaction(() => {
        const current = this.requireGoal(sessionId, goalId);
        const budgetCode = goalBudgetStopCode(current, current.usage);
        const goal = this.context.goals.updateGoal(goalId, {
          expectedRevision: paused.revision,
          objective: input.objective,
          objectiveVersion: current.objectiveVersion + 1,
          phase: "preparing", requirements: [], preparationEpisodeId: null,
          pluginId,
          status: budgetCode ? "paused" : "active",
          noProgressCount: 0,
          stagnationCount: 0, assessment: null,
          blockerKey: null,
          currentRunId: null,
          reason: budgetCode ? "已保存新正文；调整预算后请明确继续" : null,
          stopReason: budgetCode ? { code: budgetCode, at: Date.now() } : null,
          wait: null,
        });
        return this.prepare(goal, input.requestId, input, { changeKind: input.changeKind,
          changeReason: input.changeReason, previousVersion: current.objectiveVersion,
          replaceRequirementIds: input.replaceRequirementIds });
      });
      return updated.status === "paused" ? updated : this.finishDispatch(input.requestId, updated);
    }, async () => {
      ({ pluginId } = await this.context.pluginCapabilities.admit(this.requireSession(sessionId), input.items ?? []));
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
      if (input.action === "confirm") return this.confirmRequirements(goal, input);
      if (input.action === "resume" && goal.phase === "preparing") return this.resumePreparation(goal, input);
      if (input.reprepare) throw new SessionApplicationError(409, "只有准备阶段可以重新整理目标");
      const retryRun = input.action === "resume" ? (this.waitDispatchCandidate(goal) ?? this.initialDispatchCandidate(goal)) : undefined;
      if (input.action === "resume") this.validateResume(goal, input, retryRun?.id);
      const updated = this.context.transaction.transaction(() => {
        const changed = this.context.goals.updateGoal(goalId, {
          expectedRevision: input.expectedRevision,
          status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : input.action === "confirm" ? "completed" : "active",
          maxAutoTurns: goal.maxAutoTurns === 0 ? 0 : goal.maxAutoTurns + (input.action === "resume" ? (input.additionalAutoTurns ?? 0) : 0),
          ...(input.action === "resume" ? { noProgressCount: 0, stagnationCount: 0, blockerKey: null, currentRunId: null } : {}),
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
        if (typeof run.metadata.goalId === "string") this.context.goals.refreshGoalRunTime(run.metadata.goalId);
        const goal = typeof run.metadata.goalId === "string" ? this.context.goals.getGoal(run.metadata.goalId) : undefined;
        if (!goal || goal.sessionId !== sessionId || goal.objectiveVersion !== run.metadata.goalObjectiveVersion) return;
        if (run.metadata.goalPhase === "preparing") { nextRunId = this.settlePreparation(goal, run); return; }
        if (goal.phase !== "executing" || goal.currentRunId !== runId) return;
        this.context.goals.finishGoalRun(runId);
        this.context.runs.updateRun(runId, {
          metadata: { goalSettled: true },
        });
        if (goal.status !== "active") return;
        const budget = this.context.goals.checkGoalBudget(goal.id);
        if (budget.code) { budgetClosed = Boolean(budget.budgetClosed); return; }
        if (this.control.hasUserWork(sessionId)) return;
        let currentAssessment: GoalAssessment | undefined;
        const change = (patch: Omit<Parameters<GoalOperations["updateGoal"]>[1], "expectedRevision">) =>
          this.context.goals.updateGoal(goal.id, {
            expectedRevision: goal.revision,
            currentRunId: null,
            ...(currentAssessment ? { assessment: currentAssessment } : {}),
            ...patch,
          });
        if (run.status !== "completed") {
          change({
            status: "paused",
            reason: run.error ?? "目标回合被中断或执行失败",
            stopReason: { code: "run_error", at: Date.now(), runId },
          });
          return;
        }
        let assessment: GoalAssessment;
        try {
          assessment = parseGoalAssessment(run.metadata.goalAssessment, {
            goalId: goal.id,
            objectiveVersion: goal.objectiveVersion,
            runId,
            phase: "executing",
          });
          validateRequirementCoverage(goal.requirements, assessment.requirements ?? []);
        } catch {
          change({ status: "paused", reason: "目标回合没有提交有效评估", stopReason: { code: "assessment_invalid", at: Date.now(), runId } });
          return;
        }
        currentAssessment = assessment;
        const verified = readGoalEvidence(this.context, goal, assessment);
        assessment.hostEvidence = verified;
        assessment.requirements = assessment.requirements?.map(item => item.status === "satisfied" && !requirementEvidenceSatisfied(goal, assessment, verified, item.requirementId)
          ? { ...item, status: goal.requirements.find(formal => formal.id === item.requirementId)?.verification.kind === "user_acceptance" ? "needs_user" : "incomplete" } : item);
        const permission = this.context.permissions.list({ sessionId, status: "pending" })[0];
        if (permission) assessment.wait = { kind: "approval", permissionRequestId: permission.id };
        const diagnostics = readGoalDiagnostics(this.context, goal, assessment);
        assessment.hostDiagnostics = diagnostics;
        const progress = evaluateGoalProgress({ goal, assessment, evidence: verified,
          diagnostics,
          history: this.context.goals.listGoalAssessments(goal.id, goal.objectiveVersion) });
        assessment.hostProgress = { verifiedSignals: progress.verifiedSignals, stagnationCount: progress.stagnationCount, noProgressCount: progress.noProgressCount };
        currentAssessment = assessment;
        this.context.goals.recordGoalAssessment({ goalId: goal.id, revision: goal.revision, runId, assessment: { ...assessment } });
        if (permission) {
          change({
            status: "waiting_user",
            reason: "目标需要批准后才能继续",
            wait: { kind: "approval", permissionRequestId: permission.id },
          });
          return;
        }
        if (assessment.decision === "complete") {
          const disposition = classifyGoalCompletion(goal, assessment, verified);
          if (disposition.kind === "completed") {
            change({
              status: "completed",
              evidence: assessment.evidence,
              reason: null,
            });
            return;
          }
          if (disposition.kind === "waiting_user") {
            change({
              status: "waiting_user",
              evidence: assessment.evidence,
              reason: disposition.reason,
              wait: {
                kind: "user",
                purpose: "acceptance", objectiveVersion: goal.objectiveVersion,
                requirementIds: disposition.requirementIds,
                questionId: `goal-complete-${runId}`,
                question: "现有结果是否满足以下待验收条件？",
              },
            });
            return;
          }
          assessment = {
            ...assessment,
            decision: "continue",
            nextStep: disposition.reason,
          };
        }
        if (assessment.decision === "waiting_user") {
          const wait = assessment.wait;
          if (wait?.kind === "external")
            change({
              status: "paused",
              reason: "本轮已经结束，外部任务仍需在恢复后重新检查",
            });
          else if (wait?.kind === "approval") {
            const actual = this.context.permissions.get(wait.permissionRequestId);
            if (!actual || actual.sessionId !== sessionId || actual.runId !== runId) change({ status: "paused", reason: "评估引用的批准请求无效", stopReason: { code: "assessment_invalid", at: Date.now(), runId } });
            else
              change({
                status: "waiting_user",
                wait,
                reason: assessment.reason ?? "请处理批准请求",
              });
          } else
            change({
              status: "waiting_user",
              evidence: assessment.evidence,
              reason: assessment.reason ?? assessment.nextStep ?? assessment.progress,
              wait: {
                kind: "user",
                purpose: "clarification", objectiveVersion: goal.objectiveVersion,
                questionId: `goal-question-${runId}`,
                question: wait?.kind === "user" ? wait.question : (assessment.reason ?? "请补充目标所需信息"),
              },
            });
          return;
        }
        if (assessment.progressAssessment.kind === "waiting") {
          if (assessment.wait?.kind !== "external" || !this.context.waitVerifier) {
            change({ status: "paused", reason: "等待项缺少可验证的 Run ID", stopReason: { code: "wait_invalid", at: Date.now(), runId } });
            return;
          }
          const check = this.context.waitVerifier.check(sessionId, assessment.wait);
          const observed = this.context.runs.getRun(assessment.wait.targetRunId)?.status;
          if (observed) assessment.wait.observedStatus = observed;
          if (check.state === "running" || check.state === "unknown" || check.state === "completed") {
            waitToObserve = change({
              status: "active", wait: assessment.wait, reason: assessment.progressAssessment.summary, stopReason: null,
            });
          } else {
            change({
              status: "paused",
              reason: check.state === "failed" ? check.reason : "等待的外部任务不存在或归属不匹配",
              stopReason: { code: check.state === "failed" ? check.code : "wait_invalid", at: Date.now(), runId },
            });
            return;
          }
        }
        if (waitToObserve) {
          return;
        }
        const blockerKey = progress.trustedProgress ? undefined : assessment.progressAssessment.blockerKey;
        const noProgressCount = progress.noProgressCount;
        if (progress.disposition) {
          change({
            status: progress.disposition,
            noProgressCount,
            stagnationCount: progress.stagnationCount,
            blockerKey,
            reason: progress.disposition === "blocked" ? "连续三轮未推进，当前有阻塞依据" : "连续三轮尚未核实到进展，请检查现有工作",
            stopReason: { code: "no_progress", at: Date.now(), runId, detail: this.stopSummary(goal, assessment) },
          });
          return;
        }
        if (goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns) {
          change({ status: "paused", reason: "目标自动续跑额度已用完", stopReason: { code: "auto_turn_limit", at: Date.now(), runId } });
          return;
        }
        if (!assessment.nextStep?.trim()) {
          change({ status: "paused", reason: "评估没有给出可执行的下一步", stopReason: { code: "assessment_invalid", at: Date.now(), runId } });
          return;
        }
        if (this.context.runs.listRuns(sessionId).some((candidate) => candidate.id !== runId && candidate.metadata.goalId === goal.id && (candidate.status === "pending" || candidate.status === "running"))) return;
        const continued = change({
          noProgressCount,
          stagnationCount: progress.stagnationCount,
          blockerKey: blockerKey ?? null,
          evidence: assessment.evidence,
          reason: null,
        });
        const admitted = this.admission.persistGoalRun(
          sessionId,
          this.runInput(continued, `goal-${goal.id}-${goal.revision}-${runId}`, "continuation", {
            items: [
              {
                type: "text",
                text: `继续推进目标。下一步：${assessment.nextStep}`,
              },
            ],
          }),
        );
        if (
          !this.context.goals.recordGoalContinuation({
            goalId: goal.id,
            revision: goal.revision,
            previousRunId: runId,
            inputId: admitted.input.id,
            runId: admitted.run.id,
          })
        )
          throw new Error("目标续跑已存在");
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
      if (goal?.status === "active") {
        this.context.goals.updateGoal(goal.id, {
          expectedRevision: goal.revision,
          status: "paused",
          currentRunId: null,
          reason: `目标结算失败，请检查后继续：${error instanceof Error ? error.message : String(error)}`,
          stopReason: { code: "run_error", at: Date.now(), runId: nextRunId ?? runId },
        });
        this.control.cancelGoalRuns(sessionId, goal.id, "目标结算失败");
      }
    } finally {
      this.context.events.publishSince(before);
    }
  }

  private settlePreparation(goal: SessionGoal, run: SessionRunRecord): string | undefined {
    const episode = goal.preparationEpisodeId ? this.context.goals.getPreparationEpisode(goal.preparationEpisodeId) : undefined;
    if (goal.phase !== "preparing" || !episode || run.metadata.goalEpisodeId !== episode.episodeId) return;
    if (run.status !== "completed") {
      this.context.runs.updateRun(run.id, { metadata: { goalSettled: true } });
      if (goal.status === "active") this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision,
        status: "paused", currentRunId: null, reason: run.error ?? "准备被中断，请检查后继续",
        stopReason: { code: "run_error", at: Date.now(), runId: run.id } });
      return;
    }
    let assessment: GoalAssessment;
    try {
      assessment = parseGoalAssessment(run.metadata.goalAssessment, { goalId: goal.id, objectiveVersion: goal.objectiveVersion, runId: run.id, phase: "preparing" });
      if (assessment.decision === "ready") this.preparedRequirements(goal, episode, assessment);
    } catch (error) {
      if (goal.status === "active") this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision,
        status: "paused", currentRunId: null, wait: null,
        reason: "暂时无法整理目标条件，请重新整理，或编辑目标后重试。",
        stopReason: { code: "preparation_incomplete", at: Date.now(), runId: run.id,
          detail: error instanceof Error ? error.message : String(error) } });
      this.context.goals.setPreparationEpisode({ ...episode, state: "stopped" });
      this.context.runs.updateRun(run.id, { metadata: { goalSettled: true } });
      return;
    }
    if (assessment.decision === "ready") {
      const ready = this.context.goals.setPreparationEpisode({ ...episode, readyRunId: run.id, state: "ready" });
      if (goal.status !== "active" || this.context.goals.checkGoalBudget(goal.id).code) return;
      if (this.control.hasUserWork(goal.sessionId)) {
        this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", currentRunId: null,
          reason: "准备结果已保存，先处理用户任务；结束后请明确继续", stopReason: null });
        return;
      }
      return this.freezePrepared(this.context.goals.getGoal(goal.id)!, ready);
    }
    if (goal.status !== "active") return;
    this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, currentRunId: null,
      status: "waiting_user", assessment,
      wait: assessment.wait ?? null,
      reason: assessment.reason ?? assessment.progress,
      stopReason: null });
    this.context.goals.setPreparationEpisode({ ...episode, state: "waiting_user" });
    this.context.runs.updateRun(run.id, { metadata: { goalSettled: true } });
  }

  private stopSummary(goal: SessionGoal, assessment: GoalAssessment): string {
    return [
      ...goal.requirements.filter(item => assessment.requirements?.find(value => value.requirementId === item.id)?.status !== "satisfied").map(item => `${item.id}：${item.text}`),
      assessment.progressAssessment.summary, ...assessment.evidence,
      assessment.nextStep ? `待确认路线：${assessment.nextStep}` : "请检查现有工作，补充条件或说明可继续的路线。",
      "恢复前请处理未决批准与预算限制；继续不会清除累计用量。",
    ].join("\n").slice(0, 4000);
  }

  private initialDispatchCandidate(goal: SessionGoal): SessionRunRecord | undefined {
    const run = goal.stopReason?.code === "run_error" && goal.stopReason.runId ? this.context.runs.getRun(goal.stopReason.runId) : undefined;
    if (!run || run.status !== "pending" || run.metadata.goalRunKind !== "initial" || !run.metadata.goalPreparedBy
      || run.metadata.goalId !== goal.id || run.metadata.goalObjectiveVersion !== goal.objectiveVersion
      || !this.context.goals.getGoalVersion(goal.id, goal.objectiveVersion)?.frozenAt) return;
    const binding = run.metadata.goalPreparedBy as { episodeId?: string; preparationRunId?: string };
    if (typeof binding.episodeId !== "string" || typeof binding.preparationRunId !== "string") return;
    const preparation = this.context.runs.getRun(binding.preparationRunId);
    const request = this.context.goals.getGoalRequest(binding.episodeId);
    if (!preparation || preparation.status !== "completed" || !preparation.metadata.goalSettled
      || preparation.metadata.goalId !== goal.id || preparation.metadata.goalObjectiveVersion !== goal.objectiveVersion
      || preparation.metadata.goalEpisodeId !== binding.episodeId || request?.result?.initialRunId !== run.id) return;
    return run;
  }

  private resumePreparation(goal: SessionGoal, input: GoalActionInput): SessionGoal {
    const answering = Boolean(input.response?.trim());
    const originalEpisode = goal.preparationEpisodeId ? this.context.goals.getPreparationEpisode(goal.preparationEpisodeId) : undefined;
    const pending = goal.stopReason?.code === "run_error" && goal.stopReason.runId ? this.context.runs.getRun(goal.stopReason.runId) : undefined;
    const retry = pending?.status === "pending" && pending.metadata.goalId === goal.id && pending.metadata.goalObjectiveVersion === goal.objectiveVersion
      && pending.metadata.goalPhase === "preparing" && pending.metadata.goalEpisodeId === originalEpisode?.episodeId
      && originalEpisode?.runId === pending.id && !this.admission.isRunQueuedOrRunning(pending.id) ? pending : undefined;
    this.validateResume(goal, input, retry?.id, answering);
    const result = this.context.transaction.transaction(() => {
      const budget = goalBudgetStopCode(goal, goal.usage);
      let active = this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: budget ? "paused" : "active",
        noProgressCount: 0, stagnationCount: 0, blockerKey: null, currentRunId: null, wait: null,
        reason: budget ? "回答已保存，调整预算后请明确继续" : null,
        stopReason: budget ? { code: budget, at: Date.now() } : null });
      if (input.reprepare || answering) {
        if (retry) this.control.cancelGoalRuns(goal.sessionId, goal.id, "用户重新整理准备条件", true);
        active = this.prepare(active, input.requestId, { items: [{ type: "text", text: input.response ?? `重新整理目标：${goal.objective}` }] });
        return { goal: active, requestId: input.requestId, runId: this.context.goals.getGoalRequest(input.requestId)?.result?.runId as string | undefined };
      }
      const episode = goal.preparationEpisodeId ? this.context.goals.getPreparationEpisode(goal.preparationEpisodeId) : undefined;
      if (!episode) throw new SessionApplicationError(409, "准备批次记录缺失，请重新整理");
      let runId: string;
      if (episode.readyRunId) runId = this.freezePrepared(active, episode);
      else if (retry) runId = retry.id;
      else {
        const admitted = this.admission.persistGoalRun(goal.sessionId, this.runInput(active, input.requestId, "preparation", {
          items: [{ type: "text", text: `继续原准备批次，整理目标条件：${goal.objective}` }], transcriptVisibility: "hidden" }));
        runId = admitted.run.id;
        this.context.goals.setPreparationEpisode({ ...episode, runId, state: "running" });
      }
      active = this.context.goals.getGoal(goal.id)!;
      this.context.goals.settleGoalRequest(input.requestId, { status: "pending", goalId: goal.id, result: { goal: active, runId } });
      return { goal: active, requestId: input.requestId, runId };
    });
    return result.runId ? this.finishDispatch(result.requestId, result.goal) : result.goal;
  }

  private confirmRequirements(goal: SessionGoal, input: GoalActionInput): SessionGoal {
    const wait = goal.wait;
    if (goal.phase !== "executing" || goal.status !== "waiting_user" || wait?.kind !== "user" || wait.purpose !== "acceptance"
      || wait.questionId !== input.questionId || wait.objectiveVersion !== input.objectiveVersion || !goal.assessment
      || !wait.requirementIds?.length || wait.requirementIds.some(id => goal.requirements.find(item => item.id === id)?.verification.kind !== "user_acceptance"))
      throw new SessionApplicationError(409, "当前目标没有等待这些条件的验收");
    const saved = this.context.transaction.transaction(() => {
      const admitted = this.admission.persistGoalInput(goal.sessionId, { id: input.requestId, items: [{ type: "text", text: `用户确认条件：${wait.requirementIds!.join("、")}` }] });
      const assessment: GoalAssessment = { ...goal.assessment!,
        requirements: goal.assessment!.requirements!.map(item => wait.requirementIds!.includes(item.requirementId) ? { ...item, status: "satisfied" } : item),
        userReceipts: [...(goal.assessment!.userReceipts ?? []), { requestId: input.requestId, inputId: admitted.id, actor: { kind: "local_user" },
          at: Date.now(), questionId: wait.questionId, objectiveVersion: goal.objectiveVersion, requirementIds: wait.requirementIds! }] };
      const verified = readGoalEvidence(this.context, goal, assessment);
      const disposition = classifyGoalCompletion(goal, assessment, verified);
      if (disposition.kind !== "completed") throw new SessionApplicationError(409, "其他条件或当前证据尚未满足，请先完成检查");
      const changed = this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "completed", wait: null, reason: null, assessment });
      this.context.goals.recordGoalAssessment({ goalId: goal.id, revision: changed.revision, runId: assessment.runId, assessment: { ...assessment } });
      this.context.goals.settleGoalRequest(input.requestId, { status: "completed", goalId: goal.id, result: { goal: changed } });
      return changed;
    });
    return saved;
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

  private validateResume(goal: SessionGoal, input: GoalActionInput, retryRunId?: string, savingAnswer = false): void {
    if (!["paused", "blocked", "waiting_user"].includes(goal.status)) throw new SessionApplicationError(409, `Goal cannot resume from ${goal.status}`);
    if (goal.maxAutoTurns > 0 && goal.maxAutoTurns + (input.additionalAutoTurns ?? 0) > MAX_GOAL_AUTO_TURNS) throw new SessionApplicationError(400, "自动续跑总额度最多为 1000");
    if (goal.maxAutoTurns > 0 && goal.phase === "executing" && goal.autoTurnsUsed >= goal.maxAutoTurns + (input.additionalAutoTurns ?? 0)) throw new SessionApplicationError(409, "请明确增加自动续跑额度");
    if (this.control.hasUserWork(goal.sessionId)) throw new SessionApplicationError(409, "请先等待用户任务结束");
    if (!savingAnswer && goalBudgetStopCode(goal, goal.usage)) throw new SessionApplicationError(409, "Token 预算已用完或用量不完整，请先调整预算");
    if (this.context.runs.listGoalRuns(goal.id).some((run) => run.id !== retryRunId && (run.status === "pending" || run.status === "running"))) throw new SessionApplicationError(409, "目标仍在停止，请稍后继续");
    if (goal.status === "blocked" && !input.response?.trim()) throw new SessionApplicationError(409, "请说明阻塞条件发生了什么变化，再检查并继续");
    if (goal.status === "waiting_user") {
      if (goal.wait?.kind === "user" && (goal.wait.purpose !== "clarification" || !input.response?.trim() || goal.wait.questionId !== input.questionId || goal.wait.objectiveVersion !== input.objectiveVersion)) throw new SessionApplicationError(409, "请先回答当前版本的问题；验收请使用指定项确认");
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
        || run.metadata.goalObjectiveVersion !== goal.objectiveVersion || run.metadata.goalPhase !== goal.phase
        || (goal.phase === "preparing" && run.metadata.goalEpisodeId !== goal.preparationEpisodeId)) throw new SessionApplicationError(409, "待派发目标已变化，请刷新后继续");
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
  private prepare(goal: SessionGoal, requestId: string,
    input: { items?: AdmitPromptInput["items"]; attachments?: AdmitPromptInput["attachments"] },
    change?: { changeKind: GoalVersion["changeKind"]; changeReason: string; previousVersion?: number; replaceRequirementIds?: string[] }): SessionGoal {
    const changed = this.context.goals.updateGoal(goal.id, { expectedRevision: goal.revision, preparationEpisodeId: requestId });
    const prompt = this.runInput(changed, requestId, "preparation", { ...input,
      items: [{ type: "text", text: goal.objective }, ...(input.items ?? []).filter(item => item.type !== "text" || item.text !== goal.objective)] });
    const budgetCode = goalBudgetStopCode(changed, changed.usage);
    const admitted = budgetCode ? { input: this.admission.persistGoalInput(goal.sessionId, prompt), run: undefined }
      : this.admission.persistGoalRun(goal.sessionId, prompt);
    let version = this.context.goals.getGoalVersion(goal.id, goal.objectiveVersion);
    if (!version) {
      const previous = change?.previousVersion ? this.context.goals.getGoalVersion(goal.id, change.previousVersion) : undefined;
      version = this.context.goals.beginGoalVersion({ goalId: goal.id, objectiveVersion: goal.objectiveVersion,
        objective: goal.objective, requirements: [], changeKind: change?.changeKind ?? "create",
        changeReason: change?.changeReason ?? "用户重新整理目标", previousVersion: change?.previousVersion,
        actor: { kind: "local_user" }, requestId, inputIds: [...new Set([...(previous?.inputIds ?? []), admitted.input.id])], createdAt: Date.now() });
    } else this.context.goals.appendGoalVersionInput(goal.id, goal.objectiveVersion, admitted.input.id);
    const episode: PreparationEpisode = { episodeId: requestId, goalId: goal.id, objectiveVersion: goal.objectiveVersion,
      inputIds: this.context.goals.getGoalVersion(goal.id, goal.objectiveVersion)!.inputIds,
      modelAttempts: 0, readToolCalls: 0, runId: admitted.run?.id, state: admitted.run ? "running" : "accepted" };
    this.context.goals.setPreparationEpisode(episode);
    this.context.goals.settleGoalRequest(requestId, { status: admitted.run ? "pending" : "completed", goalId: goal.id,
      result: { ...this.context.goals.getGoalRequest(requestId)?.result, goal: changed,
        replaceRequirementIds: change?.replaceRequirementIds ?? this.context.goals.getGoalRequest(version.requestId)?.result?.replaceRequirementIds ?? [],
        runId: admitted.run?.id, inputId: admitted.input.id } });
    return changed;
  }

  private freezePrepared(goal: SessionGoal, episode: PreparationEpisode): string {
    const run = episode.readyRunId ? this.context.runs.getRun(episode.readyRunId) : undefined;
    if (!run || run.status !== "completed" || run.metadata.goalSettled || run.metadata.goalObjectiveVersion !== goal.objectiveVersion
      || run.metadata.goalEpisodeId !== episode.episodeId || goal.preparationEpisodeId !== episode.episodeId)
      throw new SessionApplicationError(409, "准备结果已失效，请重新整理目标");
    this.checkExecution(goal.id, goal.objectiveVersion);
    const assessment = parseGoalAssessment(run.metadata.goalAssessment, { goalId: goal.id, objectiveVersion: goal.objectiveVersion, runId: run.id, phase: "preparing" });
    const requirements = this.preparedRequirements(goal, episode, assessment);
    const frozen = this.context.goals.freezeGoalVersion({ goalId: goal.id, objectiveVersion: goal.objectiveVersion,
      expectedRevision: goal.revision, runId: run.id, requirements });
    const inputId = `goal-initial-${goal.id}-${goal.objectiveVersion}`;
    const admitted = this.admission.persistGoalRun(goal.sessionId, this.runInput(frozen, inputId, "initial", { items: [{ type: "text", text: `按已冻结的正式条件推进目标：${goal.objective}` }] }));
    this.context.runs.updateRun(admitted.run.id, { metadata: { goalPreparedBy: { episodeId: episode.episodeId, preparationRunId: run.id } } });
    const request = this.context.goals.getGoalRequest(episode.episodeId)!;
    this.context.goals.settleGoalRequest(episode.episodeId, { status: "completed", goalId: goal.id,
      result: { ...request.result, initialRunId: admitted.run.id } });
    this.context.runs.updateRun(run.id, { metadata: { goalSettled: true } });
    return admitted.run.id;
  }

  private preparedRequirements(goal: SessionGoal, episode: PreparationEpisode, assessment: GoalAssessment): GoalRequirement[] {
    const version = this.context.goals.getGoalVersion(goal.id, goal.objectiveVersion)!;
    const previous = version.previousVersion ? this.context.goals.getGoalVersion(goal.id, version.previousVersion) : undefined;
    const replacements = this.context.goals.getGoalRequest(version.requestId)?.result?.replaceRequirementIds as string[] | undefined;
    const result = (assessment.preparedRequirements ?? []).map((candidate, index) => {
      const old = previous?.requirements.find(item => item.id === candidate.previousRequirementId);
      const unchanged = old && JSON.stringify([old.text, old.verification, old.constraints]) === JSON.stringify([candidate.text, candidate.verification, candidate.constraints]);
      if (old && !unchanged && version.changeKind === "refine" && !replacements?.includes(old.id)) throw new Error("请明确选择要替换的原条件");
      for (const source of candidate.source) {
        if (source.kind === "input") {
          const input = version.inputIds.includes(source.inputId) ? this.context.conversations.getInput(source.inputId) : undefined;
          if (!input || input.sessionId !== goal.sessionId || !input.content.includes(source.quote)) throw new Error("条件缺少有效用户输入来源");
        } else {
          const part = this.context.conversations.listMessageParts(goal.sessionId).find(item => item.id === source.evidencePartId);
          const facts = part?.metadata?.hostFileFacts as { files?: Array<{ path: string; afterDigest: string; operation: string; bodyVisible?: boolean }> } | undefined;
          const message = part && this.context.conversations.listMessages(goal.sessionId).find(item => item.id === part.messageId);
          const sourceRun = message?.runId ? this.context.runs.getRun(message.runId) : undefined;
          const inherited = unchanged && old.source.some(item => item.kind === "document" && item.evidencePartId === source.evidencePartId && item.digest === source.digest);
          const output = part?.output as { content?: Array<{ type: string; text?: string }> } | string | undefined;
          const text = typeof output === "string" ? output : output?.content?.filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
          if (!part || part.status !== "completed" || !text?.includes(source.quote) || !sourceRun || sourceRun.metadata.goalId !== goal.id
            || (!inherited && sourceRun.metadata.goalEpisodeId !== episode.episodeId)
            || !facts?.files?.some(item => item.operation === "read" && item.bodyVisible && item.path === source.path && item.afterDigest === source.digest)) throw new Error("文档引用与读取记录不一致");
        }
      }
      const requiredCommand = candidate.verification.kind === "check" && candidate.verification.commandPolicy === "required" ? candidate.verification.command : undefined;
      if (candidate.verification.kind === "check" && candidate.verification.commandPolicy === "required"
        && (!requiredCommand || !candidate.source.some(source => source.quote.includes(requiredCommand))))
        throw new Error("强制执行的命令必须来自用户输入或引用材料，不能将模型建议变成强制条件");
      const { previousRequirementId: _previous, ...definition } = candidate;
      return { ...definition, id: unchanged ? old.id : `R${goal.objectiveVersion}-${index + 1}`,
        ...(old && !unchanged ? { replaces: [old.id] } : {}) };
    });
    if (version.changeKind === "refine" && previous) {
      for (const old of previous.requirements) if (!result.some(item => item.id === old.id || item.replaces?.includes(old.id))) {
        if (replacements?.includes(old.id)) throw new Error("替换项缺少新条件，请补充");
        result.push(old);
      }
    }
    if (!result.length || result.length > 64) throw new Error("正式条件必须为 1 到 64 项，请缩小目标");
    return result;
  }

  private persistRun(
    goal: SessionGoal,
    requestId: string,
    kind: string,
    input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
      transcriptVisibility?: "hidden";
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
    },
  ): AdmitPromptInput {
    const metadata = {
      goalId: goal.id,
      goalObjectiveVersion: goal.objectiveVersion,
      goalRunKind: kind,
      goalPhase: goal.phase,
      ...(goal.phase === "preparing" ? { goalEpisodeId: goal.preparationEpisodeId } : {}),
      ...(input.transcriptVisibility ? { transcriptVisibility: input.transcriptVisibility } : {}),
      ...(goal.pluginId ? { pluginId: goal.pluginId } : {}),
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
