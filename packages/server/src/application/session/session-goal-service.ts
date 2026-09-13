import { DEFAULT_GOAL_AUTO_TURNS, MAX_GOAL_AUTO_TURNS, parseGoalAssessment, type CreateSessionGoalInput, type GoalActionInput, type GoalAssessment, type SessionGoal, type UpdateSessionGoalInput } from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";
import type { SessionApplicationService } from "./session-application-service.js";
import type { SessionRunEngine, AdmitPromptInput } from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { SessionApplicationError } from "./session-application-error.js";
import { classifyGoalCompletion, verifiedGoalEvidence } from "./goal-assessment-policy.js";
import type { GoalWaitVerifier } from "./goal-wait-verifier.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";

export class SessionGoalService {
  private readonly requests = new Map<string, { fingerprint: string; promise: Promise<SessionGoal> }>();
  constructor(
    private readonly context: {
      store: SessionStore;
      sessions: Pick<SessionApplicationService, "withSessionOperation">;
      runEngine: Pick<SessionRunEngine, "persistGoalRun" | "dispatchPersistedRun" | "cancelGoalRuns" | "waitForRuns" | "hasUserWork">;
      events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
      waitVerifier?: Pick<GoalWaitVerifier, "check">;
      pluginCapabilities: Pick<SessionPluginCapabilityService, "admit">;
    },
  ) {}
  private readonly waitTimers = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();

  get(sessionId: string): SessionGoal | null {
    this.requireSession(sessionId);
    return this.context.store.getCurrentGoal(sessionId) ?? null;
  }
  getRequest(sessionId: string, requestId: string): ReturnType<SessionStore["getGoalRequest"]> {
    this.requireSession(sessionId);
    const request = this.context.store.getGoalRequest(requestId);
    if (!request || request.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal request not found: ${requestId}`);
    return request;
  }
  create(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    return this.command(sessionId, input.requestId, { operation: "create", ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const goal = this.context.store.transaction(() => {
        const created = this.context.store.createGoal({
          sessionId,
          objective: input.objective,
          maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS,
        });
        this.persistRun(created, input.requestId, "initial", input);
        return created;
      });
      return this.finishDispatch(input.requestId, goal);
    }, () => this.assertGoalPluginCapabilityUnsupported(sessionId, input.items));
  }
  update(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    return this.command(sessionId, input.requestId, { operation: "update", goalId, ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const request = this.context.store.getGoalRequest(input.requestId)!;
      let paused: SessionGoal;
      if (request.result?.phase === "stopping") {
        paused = this.requireGoal(sessionId, goalId);
        if (paused.revision !== request.result.revision || paused.status !== "paused") throw new SessionApplicationError(409, "目标在停止期间已被修改，请重新提交");
      } else {
        this.assertOpen(this.requireGoal(sessionId, goalId));
        paused = this.context.store.transaction(() => {
          const changed = this.context.store.updateGoal(goalId, {
            expectedRevision: input.expectedRevision,
            status: "paused",
            reason: "正在更新目标",
          });
          this.context.store.settleGoalRequest(input.requestId, {
            status: "pending",
            goalId,
            result: { phase: "stopping", revision: changed.revision },
          });
          return changed;
        });
      }
      await this.stopRuns(paused, "目标正文已修改");
      const updated = this.context.store.transaction(() => {
        const goal = this.context.store.updateGoal(goalId, {
          expectedRevision: paused.revision,
          objective: input.objective,
          status: "active",
          noProgressCount: 0,
          blockerKey: null,
          currentRunId: null,
          reason: null,
          wait: null,
        });
        this.persistRun(goal, input.requestId, "edit", input);
        return goal;
      });
      return this.finishDispatch(input.requestId, updated);
    }, () => this.assertGoalPluginCapabilityUnsupported(sessionId, input.items));
  }
  action(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    return this.command(sessionId, input.requestId, { operation: "action", goalId, ...input }, async () => {
      const replay = await this.replay(input.requestId);
      if (replay) return replay;
      const goal = this.requireGoal(sessionId, goalId);
      this.assertOpen(goal);
      if (goal.revision !== input.expectedRevision) throw new SessionApplicationError(409, "目标已变化，请刷新后重试");
      if (input.action === "confirm" && (goal.status !== "waiting_user" || goal.wait?.kind !== "user" || !goal.wait.questionId.startsWith("goal-complete-") || input.questionId !== goal.wait.questionId)) throw new SessionApplicationError(409, "当前目标没有等待这次验收");
      if (input.action === "resume") this.validateResume(goal, input);
      const updated = this.context.store.transaction(() => {
        const changed = this.context.store.updateGoal(goalId, {
          expectedRevision: input.expectedRevision,
          status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : input.action === "confirm" ? "completed" : "active",
          maxAutoTurns: goal.maxAutoTurns + (input.action === "resume" ? (input.additionalAutoTurns ?? 0) : 0),
          ...(input.action === "resume" ? { noProgressCount: 0, blockerKey: null, currentRunId: null } : {}),
          reason: null,
          wait: null,
        });
        if (input.action === "resume")
          this.persistRun(changed, input.requestId, "resume", {
            items: [
              {
                type: "text",
                text: input.response ? `${changed.objective}\n\n用户补充：${input.response}` : changed.objective,
              },
            ],
          });
        else
          this.context.store.settleGoalRequest(input.requestId, {
            status: "pending",
            goalId,
            result: { goal: changed, phase: "action-stopping" },
          });
        return changed;
      });
      if (input.action === "resume") return this.finishDispatch(input.requestId, updated);
      await this.stopRuns(updated, input.action === "cancel" ? "用户取消目标" : "用户停止目标");
      const stopped = this.context.store.getGoal(goalId)!;
      this.context.store.settleGoalRequest(input.requestId, {
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
    try {
      this.context.store.transaction(() => {
        const run = this.context.store.getRun(runId);
        if (!run || run.sessionId !== sessionId || run.status === "pending" || run.status === "running" || run.metadata.goalSettled) return;
        this.context.store.finishGoalRun(runId);
        const goal = typeof run.metadata.goalId === "string" ? this.context.store.getGoal(run.metadata.goalId) : undefined;
        if (!goal || goal.sessionId !== sessionId || goal.status !== "active" || goal.revision !== run.metadata.goalRevision || (goal.currentRunId && goal.currentRunId !== runId)) return;
        this.context.store.updateRun(runId, {
          metadata: { goalSettled: true },
        });
        if (this.context.runEngine.hasUserWork(sessionId)) return;
        let currentAssessment: GoalAssessment | undefined;
        const change = (patch: Omit<Parameters<SessionStore["updateGoal"]>[1], "expectedRevision">) =>
          this.context.store.updateGoal(goal.id, {
            expectedRevision: goal.revision,
            currentRunId: null,
            ...(currentAssessment ? { assessment: currentAssessment } : {}),
            ...patch,
          });
        if (run.status !== "completed") {
          change({
            status: "paused",
            reason: run.error ?? "目标回合被中断或执行失败",
          });
          return;
        }
        let assessment: GoalAssessment;
        try {
          assessment = parseGoalAssessment(run.metadata.goalAssessment, {
            goalId: goal.id,
            revision: goal.revision,
            runId,
          });
        } catch {
          change({ status: "paused", reason: "目标回合没有提交有效评估" });
          return;
        }
        currentAssessment = assessment;
        const verified = verifiedGoalEvidence(this.context.store, goal, assessment);
        const priorSignatures = new Set(this.context.store.goalEvidenceSignatures(goal.id));
        const verifiedSignatures = verified.map((part) => JSON.stringify([part.toolName, part.input, part.output]));
        const hasNewEvidence = verifiedSignatures.some((signature) => !priorSignatures.has(signature));
        this.context.store.recordGoalAssessment({
          goalId: goal.id,
          revision: goal.revision,
          runId,
          assessment: { ...assessment, verifiedSignatures },
        });
        const permission = this.context.store.listPermissionRequests({
          sessionId,
          status: "pending",
        })[0];
        if (permission) {
          change({
            status: "waiting_user",
            reason: "目标需要批准后才能继续",
            wait: { kind: "approval", permissionRequestId: permission.id },
          });
          return;
        }
        if (assessment.decision === "complete") {
          const disposition = classifyGoalCompletion(assessment, new Set(verified.map((part) => part.id)));
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
                questionId: `goal-complete-${runId}`,
                question: "现有结果是否满足目标的全部完成条件？",
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
            const actual = this.context.store.getPermissionRequest(wait.permissionRequestId);
            if (!actual || actual.sessionId !== sessionId || actual.runId !== runId) change({ status: "paused", reason: "评估引用的批准请求无效" });
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
                questionId: `goal-question-${runId}`,
                question: wait?.kind === "user" ? wait.question : (assessment.reason ?? "请补充目标所需信息"),
              },
            });
          return;
        }
        if (assessment.progressAssessment.kind === "waiting") {
          if (assessment.wait?.kind !== "external" || !this.context.waitVerifier) {
            change({ status: "paused", reason: "等待项缺少可验证的运行句柄" });
            return;
          }
          const check = this.context.waitVerifier.check(sessionId, assessment.wait);
          if (check.state === "running" || check.state === "unknown") {
            waitToObserve = change({
              status: "active",
              wait: assessment.wait,
              reason: assessment.progressAssessment.summary,
            });
          } else if (check.state === "completed") {
            assessment = {
              ...assessment,
              progressAssessment: {
                kind: "progress",
                summary: "等待的外部任务已经完成",
              },
              wait: undefined,
            };
          } else {
            change({
              status: "paused",
              reason: check.state === "failed" ? check.reason : "等待的外部任务不存在或不属于当前会话",
            });
            return;
          }
        }
        if (waitToObserve) {
          return;
        }
        const madeProgress = assessment.progressAssessment.kind === "progress" && hasNewEvidence;
        const blockerKey = madeProgress ? undefined : (assessment.progressAssessment.blockerKey ?? "unverified-progress");
        const noProgressCount = madeProgress ? 0 : goal.blockerKey === blockerKey ? goal.noProgressCount + 1 : 1;
        if (noProgressCount >= 3) {
          change({
            status: "blocked",
            noProgressCount,
            blockerKey,
            reason: assessment.reason ?? assessment.progressAssessment.summary,
          });
          return;
        }
        if (goal.autoTurnsUsed >= goal.maxAutoTurns) {
          change({ status: "paused", reason: "目标自动续跑额度已用完" });
          return;
        }
        if (!assessment.nextStep?.trim()) {
          change({ status: "paused", reason: "评估没有给出可执行的下一步" });
          return;
        }
        if (this.context.store.listRuns(sessionId).some((candidate) => candidate.id !== runId && candidate.metadata.goalId === goal.id && (candidate.status === "pending" || candidate.status === "running"))) return;
        const continued = change({
          noProgressCount,
          blockerKey: blockerKey ?? null,
          evidence: assessment.evidence,
          reason: null,
        });
        const admitted = this.context.runEngine.persistGoalRun(
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
          !this.context.store.recordGoalContinuation({
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
      if (waitToObserve) this.observeExternalWait(waitToObserve);
      if (nextRunId) {
        this.context.runEngine.dispatchPersistedRun(nextRunId);
        this.context.store.markGoalContinuation(nextRunId, "dispatched");
      }
    } catch (error) {
      const run = this.context.store.getRun(runId);
      const goal = typeof run?.metadata.goalId === "string" ? this.context.store.getGoal(run.metadata.goalId) : undefined;
      if (goal?.status === "active") {
        this.context.store.updateGoal(goal.id, {
          expectedRevision: goal.revision,
          status: "paused",
          currentRunId: null,
          reason: `目标结算失败，请检查后继续：${error instanceof Error ? error.message : String(error)}`,
        });
        this.context.runEngine.cancelGoalRuns(sessionId, goal.id, "目标结算失败");
      }
    } finally {
      this.context.events.publishSince(before);
    }
  }

  private observeExternalWait(goal: SessionGoal, attempt = 0): void {
    const wait = goal.wait;
    if (wait?.kind !== "external" || !this.context.waitVerifier) return;
    this.clearWaitObserver(goal.id);
    const delay = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000][Math.min(attempt, 5)]!;
    const timer = setTimeout(() => {
      this.waitTimers.delete(goal.id);
      const current = this.context.store.getGoal(goal.id);
      if (!current || current.status !== "active" || current.revision !== goal.revision || current.wait?.kind !== "external" || current.wait.handleId !== wait.handleId) return;
      const check = this.context.waitVerifier!.check(current.sessionId, current.wait);
      if (check.state === "running" || check.state === "unknown") {
        this.observeExternalWait(current, attempt + 1);
        return;
      }
      const before = this.context.events.checkpoint();
      try {
        if (check.state !== "completed") {
          this.context.store.updateGoal(current.id, {
            expectedRevision: current.revision,
            status: "paused",
            wait: null,
            reason: check.state === "failed" ? check.reason : "等待的外部任务不存在或不属于当前会话",
          });
          return;
        }
        const continued = this.context.store.updateGoal(current.id, {
          expectedRevision: current.revision,
          status: "active",
          wait: null,
          reason: null,
        });
        const inputId = `goal-wait-${continued.id}-${continued.revision}-${wait.handleId}`;
        const admitted = this.context.runEngine.persistGoalRun(
          continued.sessionId,
          this.runInput(continued, inputId, "continuation", {
            items: [
              {
                type: "text",
                text: "等待的外部任务已结束。检查其结果并继续推进目标。",
              },
            ],
          }),
        );
        if (
          this.context.store.recordGoalContinuation({
            goalId: continued.id,
            revision: continued.revision,
            previousRunId: `wait:${wait.runId}:${wait.handleId}`,
            inputId: admitted.input.id,
            runId: admitted.run.id,
          })
        ) {
          this.context.runEngine.dispatchPersistedRun(admitted.run.id);
          this.context.store.markGoalContinuation(admitted.run.id, "dispatched");
        }
      } catch (error) {
        const failed = this.context.store.getGoal(goal.id);
        if (failed?.status === "active") {
          this.context.store.updateGoal(failed.id, {
            expectedRevision: failed.revision,
            status: "paused",
            wait: null,
            reason: `恢复等待目标失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } finally {
        this.context.events.publishSince(before);
      }
    }, delay);
    timer.unref?.();
    this.waitTimers.set(goal.id, { attempt, timer });
  }

  private clearWaitObserver(goalId: string): void {
    const current = this.waitTimers.get(goalId);
    if (!current) return;
    clearTimeout(current.timer);
    this.waitTimers.delete(goalId);
  }

  private validateResume(goal: SessionGoal, input: GoalActionInput): void {
    if (!["paused", "blocked", "waiting_user"].includes(goal.status)) throw new SessionApplicationError(409, `Goal cannot resume from ${goal.status}`);
    if (goal.maxAutoTurns + (input.additionalAutoTurns ?? 0) > MAX_GOAL_AUTO_TURNS) throw new SessionApplicationError(400, "自动续跑总额度最多为 1000");
    if (goal.autoTurnsUsed >= goal.maxAutoTurns + (input.additionalAutoTurns ?? 0)) throw new SessionApplicationError(409, "请明确增加自动续跑额度");
    if (this.context.store.listRuns(goal.sessionId).some((run) => run.metadata.goalId === goal.id && (run.status === "pending" || run.status === "running"))) throw new SessionApplicationError(409, "目标仍在停止，请稍后继续");
    if (goal.status === "blocked" && !input.response?.trim()) throw new SessionApplicationError(409, "请说明阻塞条件发生了什么变化，再检查并继续");
    if (goal.status === "waiting_user") {
      if (goal.wait?.kind === "user" && (!input.response?.trim() || goal.wait.questionId !== input.questionId)) throw new SessionApplicationError(409, "请先回答当前目标的问题");
      if (goal.wait?.kind === "approval") {
        const request = this.context.store.getPermissionRequest(goal.wait.permissionRequestId);
        if (request?.sessionId !== goal.sessionId || request.status !== "approved") throw new SessionApplicationError(409, "批准尚未通过，不能恢复目标");
      }
      if (!goal.wait || goal.wait.kind === "external") throw new SessionApplicationError(409, "等待状态尚未解除");
    }
    if (
      this.context.store.listPermissionRequests({
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
    const promise = this.context.sessions
      .withSessionOperation(sessionId, async () => {
        const before = this.context.events.checkpoint();
        try {
          await preflight?.();
          this.context.store.beginGoalRequest({
            requestId,
            sessionId,
            fingerprint,
          });
          return await work();
        } catch (error) {
          const request = this.context.store.getGoalRequest(requestId);
          if (request?.fingerprint === fingerprint && request.status !== "completed")
            this.context.store.settleGoalRequest(requestId, {
              status: request.result ? "pending" : "failed",
              goalId: request.goalId,
              result: request.result,
              error: error instanceof Error ? error.message : String(error),
            });
          if (error instanceof Error && (error.message === "session_goal_revision_conflict" || error.message === "session_goal_request_conflict" || error.message.includes("UNIQUE constraint failed"))) throw new SessionApplicationError(409, error.message);
          throw error;
        } finally {
          this.context.events.publishSince(before);
        }
      })
      .finally(() => {
        if (this.requests.get(requestId)?.promise === promise) this.requests.delete(requestId);
      });
    this.requests.set(requestId, { fingerprint, promise });
    return promise;
  }
  private async replay(requestId: string): Promise<SessionGoal | undefined> {
    const request = this.context.store.getGoalRequest(requestId)!;
    if (request.status === "completed" && request.result?.goal) return request.result.goal as unknown as SessionGoal;
    if (request.result?.phase === "action-stopping" && request.goalId) {
      const goal = this.context.store.getGoal(request.goalId)!;
      if (goal.revision !== (request.result.goal as SessionGoal).revision) throw new SessionApplicationError(409, "目标在停止期间已经变化，请刷新状态");
      await this.stopRuns(goal, "用户停止目标");
      const stopped = this.context.store.getGoal(goal.id)!;
      this.context.store.settleGoalRequest(requestId, {
        status: "completed",
        goalId: goal.id,
        result: { goal: stopped },
      });
      return stopped;
    }
    if (typeof request.result?.runId === "string" && request.goalId) return this.finishDispatch(requestId, this.context.store.getGoal(request.goalId)!);
    return undefined;
  }
  private persistRun(
    goal: SessionGoal,
    requestId: string,
    kind: string,
    input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
    },
  ): void {
    const admitted = this.context.runEngine.persistGoalRun(goal.sessionId, this.runInput(goal, requestId, kind, input));
    this.context.store.settleGoalRequest(requestId, {
      status: "pending",
      goalId: goal.id,
      result: { goal, runId: admitted.run.id, inputId: admitted.input.id },
    });
  }
  private runInput(
    goal: SessionGoal,
    requestId: string,
    kind: string,
    input: {
      items?: AdmitPromptInput["items"];
      attachments?: AdmitPromptInput["attachments"];
    },
  ): AdmitPromptInput {
    const metadata = {
      goalId: goal.id,
      goalRevision: goal.revision,
      goalRunKind: kind,
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
    const request = this.context.store.getGoalRequest(requestId)!;
    const runId = request.result?.runId;
    if (typeof runId !== "string") throw new Error("目标请求缺少持久运行记录");
    const run = this.context.store.getRun(runId);
    if (!run || run.status === "failed" || run.status === "interrupted" || goal.status !== "active" || run.metadata.goalRevision !== goal.revision) throw new SessionApplicationError(409, "目标启动已中断，请刷新目标并明确继续");
    this.context.runEngine.dispatchPersistedRun(runId);
    this.context.store.settleGoalRequest(requestId, {
      status: "completed",
      goalId: goal.id,
      result: { ...request.result, goal },
    });
    return goal;
  }
  private async stopRuns(goal: SessionGoal, reason: string): Promise<void> {
    this.clearWaitObserver(goal.id);
    const before = this.context.events.checkpoint();
    const ids = this.context.runEngine.cancelGoalRuns(goal.sessionId, goal.id, reason);
    this.context.events.publishSince(before);
    await this.context.runEngine.waitForRuns(ids);
    if (this.context.store.listRuns(goal.sessionId).some((run) => ids.includes(run.id) && (run.status === "pending" || run.status === "running"))) throw new SessionApplicationError(409, "目标尚未停止，请稍后重试");
  }
  private async assertGoalPluginCapabilityUnsupported(
    sessionId: string,
    items: AdmitPromptInput["items"] | undefined,
  ): Promise<void> {
    if (!items?.length) return;
    if (items.some((item) => item.type === "capability")) {
      throw new SessionApplicationError(409, "session_goal_plugin_capability_unsupported");
    }
    const admission = await this.context.pluginCapabilities.admit(
      this.requireSession(sessionId),
      items,
    );
    if (admission.pluginId) {
      throw new SessionApplicationError(409, "session_goal_plugin_capability_unsupported");
    }
  }
  private requireSession(sessionId: string): NonNullable<ReturnType<SessionStore["getSession"]>> {
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    return session;
  }
  private requireGoal(sessionId: string, goalId: string): SessionGoal {
    const goal = this.context.store.getGoal(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal not found: ${goalId}`);
    return goal;
  }
  private assertOpen(goal: SessionGoal): void {
    if (goal.status === "completed" || goal.status === "cancelled") throw new SessionApplicationError(409, "已结束的目标不能再修改，请新建目标");
  }
}
