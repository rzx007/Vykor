import type { AppendEventInput } from "@vykor/services";
import type { SessionEventRecord, SessionInputRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import type { SessionGoal } from "@vykor/domain-contracts/goals";
import { readRuntimeMetadata } from "@vykor/domain-contracts/sessions";
import { sessionUserInputText } from "@vykor/domain-contracts/inputs";
import { AttachmentError } from "@vykor/services";
import { normalizeTraceId } from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";
import { isCommittedPublicTextPart } from "../../session/transcript-text.js";
import { readInputPluginScope, type RunPluginSelection } from "./session-plugin-selection.js";

export interface RunControlDurableSessions {
  getSession(sessionId: string): { id: string; cwd?: string; status?: string; metadata?: Record<string, unknown> } | undefined;
  listSessions(options?: { cwd?: string; includeArchived?: boolean }): Array<{ id: string; cwd?: string; status?: string }>;
}

export interface RunControlDurableRuns {
  getRun(runId: string): SessionRunRecord | undefined;
  updateRun(runId: string, update: Partial<SessionRunRecord>): SessionRunRecord;
  listRuns(sessionId: string): SessionRunRecord[];
  listGoalRuns?(goalId: string, objectiveVersion?: number): SessionRunRecord[];
  appendEvent(event: AppendEventInput): SessionEventRecord;
  transaction<T>(fn: () => T): T;
}

export interface RunControlDurableInputs {
  getInput(inputId: string): SessionInputRecord | undefined;
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(
    sessionId: string,
    options?: { messageId?: string },
  ): SessionMessagePartRecord[];
}

export interface RunControlRuntime {
  activeRunId(sessionId: string): string | undefined;
  queuedRunIds(sessionId: string): string[];
  hasWork(sessionId: string): boolean;
  sessionIds(): string[];
  interruptSession(sessionId: string, reason?: string): {
    activeRunId?: string;
    queuedRunIds: string[];
    interrupted: boolean;
  };
  interruptRun(sessionId: string, runId: string, reason?: string): {
    activeRunId?: string;
    queuedRunIds: string[];
    interrupted: boolean;
  };
  interruptQueuedRun(sessionId: string, runId: string, reason?: string): {
    queuedRunIds: string[];
    interrupted: boolean;
    activeRunId?: string;
  };
  promoteQueuedRun(
    sessionId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
    steerInput: any,
  ):
    | { promoted: false; reason: "active_run_changed" | "queued_run_changed" }
    | { promoted: true; delivery: Promise<any> };
  waitForRun(runId: string): Promise<void>;
  waitForRuns(runIds: string[]): Promise<void>;
}

export interface RunControlEvents {
  checkpoint(): number;
  publishSince(checkpoint: number): void;
}

export interface RunControlGoals {
  getGoal?(goalId: string): SessionGoal | undefined;
  updateGoal?(goalId: string, patch: { expectedRevision: number; status: "paused"; reason: string; stopReason?: SessionGoal["stopReason"] }): SessionGoal | undefined;
  markGoalContinuation?(runId: string, status: "cancelled"): void;
}

export interface RunControlAdmissionQuery {
  hasPendingAdmission?(sessionId: string): boolean;
}

export interface RunControlServiceOptions {
  children?: { interruptRun(sessionId: string, runId: string, reason?: string): Promise<boolean> };
  durableSessions: RunControlDurableSessions;
  durableRuns: RunControlDurableRuns;
  durableInputs: RunControlDurableInputs;
  runtime: RunControlRuntime;
  events: RunControlEvents;
  goals?: RunControlGoals;
  admission?: RunControlAdmissionQuery;
  materializeSteerInput?: (sessionId: string, items: SessionInputRecord["items"]) => Promise<string>;
}

export interface PromoteQueuedRunResult {
  input: SessionInputRecord;
  queued_run: SessionRunRecord;
  active_run: SessionRunRecord;
}

export interface AwaitSessionRunResult {
  status: SessionRunRecord["status"];
  output: string;
  error?: string;
}

export class RunControlService {
  private stopPromise?: Promise<void>;
  private accepting = true;

  constructor(private readonly options: RunControlServiceOptions) {}

  activeRunId(sessionId: string): string | undefined {
    return this.options.runtime.activeRunId(sessionId);
  }

  queuedRunIds(sessionId: string): string[] {
    return this.options.runtime.queuedRunIds(sessionId);
  }

  hasWork(sessionId: string): boolean {
    return this.options.runtime.hasWork(sessionId);
  }

  hasUserWork(sessionId: string): boolean {
    if (this.options.admission?.hasPendingAdmission?.(sessionId)) return true;
    return this.options.durableRuns
      .listRuns(sessionId)
      .some(
        (run) =>
          (run.status === "pending" || run.status === "running") &&
          (!run.metadata?.goalRunKind || run.metadata.goalRunKind === "user"),
      );
  }

  hasAnyActiveRuns(): boolean {
    return this.options.durableSessions
      .listSessions({ includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.options.durableSessions
      .listSessions({ cwd, includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  interruptSession(
    sessionId: string,
    reason?: string,
  ): { activeRunId?: string; queuedRunIds: string[]; interrupted: boolean } {
    const before = this.options.events.checkpoint();
    let pauseError: unknown;
    try { this.pauseGoalForRun(this.activeRunId(sessionId)); } catch (error) { pauseError = error; }
    const result = this.options.runtime.interruptSession(sessionId, reason);
    if (result.interrupted) {
      this.options.durableRuns.transaction(() => {
        for (const runId of result.queuedRunIds) {
          this.options.durableRuns.updateRun(runId, {
            status: "interrupted",
            error: reason ?? "Queued run interrupted",
          });
        }
        this.options.durableRuns.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId: result.activeRunId,
            queuedRunIds: result.queuedRunIds,
            reason: reason ?? "Run interrupted",
          },
        });
      });
      this.options.events.publishSince(before);
    }
    if (pauseError) throw new SessionApplicationError(500, "已尝试中断，但目标暂停未保存，请重试：" + (pauseError instanceof Error ? pauseError.message : String(pauseError)));
    return result;
  }

  interruptRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): { activeRunId?: string; queuedRunIds: string[]; interrupted: boolean } {
    const before = this.options.events.checkpoint();
    const durableRun = this.options.durableRuns.getRun(runId);
    if (
      durableRun?.sessionId === sessionId &&
      durableRun.status !== "pending" &&
      durableRun.status !== "running"
    ) return { queuedRunIds: [], interrupted: false };
    let pauseError: unknown;
    if (this.activeRunId(sessionId) === runId) {
      try { this.pauseGoalForRun(runId); } catch (error) { pauseError = error; }
    }
    const result = this.options.runtime.interruptRun(sessionId, runId, reason);
    if (result.interrupted) {
      this.options.durableRuns.transaction(() => {
        for (const queuedRunId of result.queuedRunIds) {
          this.options.durableRuns.updateRun(queuedRunId, {
            status: "interrupted",
            error: reason ?? "Queued run interrupted",
          });
        }
        this.options.durableRuns.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId,
            queuedRunIds: result.queuedRunIds,
            reason: reason ?? "Run interrupted",
            scoped: true,
          },
        });
      });
      this.options.events.publishSince(before);
    }
    if (pauseError) throw new SessionApplicationError(500, "已尝试中断，但目标暂停未保存，请重试：" + (pauseError instanceof Error ? pauseError.message : String(pauseError)));
    return result;
  }

  interruptQueuedRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): { activeRunId?: string; queuedRunIds: string[]; interrupted: boolean } {
    const before = this.options.events.checkpoint();
    const result = this.options.runtime.interruptQueuedRun(
      sessionId,
      runId,
      reason,
    );
    if (result.queuedRunIds.includes(runId)) {
      this.options.durableRuns.transaction(() => {
        this.options.durableRuns.updateRun(runId, {
          status: "interrupted",
          error: reason ?? "Queued run interrupted",
        });
        this.options.durableRuns.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId,
            queuedRunIds: [runId],
            reason: reason ?? "Queued run interrupted",
            scoped: true,
            queuedOnly: true,
          },
        });
      });
      this.options.events.publishSince(before);
    }
    return result;
  }

  cancelGoalRuns(sessionId: string, goalId: string, reason: string, queuedOnly = false): string[] {
    const ids: string[] = [];
    for (const run of this.options.durableRuns.listRuns(sessionId)) {
      if (run.metadata?.goalId !== goalId || (run.status !== "pending" && run.status !== "running")) continue;
      if (queuedOnly && (run.metadata?.goalRunKind !== "continuation" || this.activeRunId(sessionId) === run.id)) continue;
      ids.push(run.id);
      this.interruptRun(sessionId, run.id, reason);
      if (this.activeRunId(sessionId) !== run.id) {
        this.options.durableRuns.updateRun(run.id, { status: "interrupted", error: reason });
      }
      this.options.goals?.markGoalContinuation?.(run.id, "cancelled");
    }
    return ids;
  }

  async promoteQueuedRun(
    sessionId: string,
    inputId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
  ): Promise<PromoteQueuedRunResult | undefined> {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const input = this.options.durableInputs.getInput(inputId);
    const queuedRun = this.options.durableRuns.getRun(queuedRunId);
    if (!input || input.sessionId !== sessionId) {
      throw new SessionApplicationError(404, `Prompt not found: ${inputId}`);
    }
    if ((typeof input.metadata?.pluginId === "string" && !input.items) || input.items?.some(item =>
      item.type === "capability" || (item.type === "skill" && item.source === "plugin")
    )) {
      throw new SessionApplicationError(409, "session_capability_requires_queued_run");
    }
    if (input.attachments.length > 0) {
      throw new AttachmentError(
        "attachment_structured_steer_unsupported",
        "Queued prompts with attachments cannot be promoted during stage two",
      );
    }
    if (!queuedRun || queuedRun.sessionId !== sessionId) {
      throw new SessionApplicationError(404, `Session run not found: ${queuedRunId}`);
    }
    const promotion = queuedRun.metadata?.promotion;
    if (
      queuedRun.status === "interrupted" &&
      promotion && typeof promotion === "object" &&
      "kind" in promotion && promotion.kind === "steered" &&
      "inputId" in promotion && promotion.inputId === inputId &&
      "activeRunId" in promotion && typeof promotion.activeRunId === "string"
    ) {
      const promotedActiveRun = this.options.durableRuns.getRun(promotion.activeRunId);
      if (!promotedActiveRun) {
        throw new SessionApplicationError(409, "The promoted prompt no longer has its target run");
      }
      return { input, queued_run: queuedRun, active_run: promotedActiveRun };
    }
    if (input.delivery !== "queue" || queuedRun.inputId !== inputId || queuedRun.status !== "pending") {
      throw new SessionApplicationError(409, "The selected prompt is no longer waiting in the queue");
    }
    if (this.options.runtime.activeRunId(sessionId) !== expectedActiveRunId) {
      throw new SessionApplicationError(409, "The active run changed before the prompt could be promoted");
    }
    const activeRun = this.options.durableRuns.getRun(expectedActiveRunId);
    if (
      !activeRun || activeRun.sessionId !== sessionId ||
      (activeRun.status !== "pending" && activeRun.status !== "running")
    ) throw new SessionApplicationError(409, "The prompt or active run changed before promotion completed");
    const inputPluginId = typeof input.metadata.pluginId === "string" ? input.metadata.pluginId : undefined;
    const activePluginId = typeof activeRun.metadata.pluginId === "string" ? activeRun.metadata.pluginId : undefined;
    const storedActiveSelection = activeRun.metadata.pluginSelection as RunPluginSelection | undefined;
    const activeInputScope = storedActiveSelection?.status !== "resolved" && !activePluginId && activeRun.inputId
      ? readInputPluginScope(this.options.durableInputs.getInput(activeRun.inputId)?.metadata.pluginScope)
      : undefined;
    const activeSelection = activeInputScope ?? storedActiveSelection;
    const queuedSelection = queuedRun.metadata.pluginSelection as RunPluginSelection | undefined;
    const activeIds = activeSelection?.scopeVersion === 2 ? activeSelection.pluginIds ?? []
      : activePluginId ? [activePluginId] : [];
    const queuedScope = queuedSelection?.scopeVersion === 2
      ? readInputPluginScope({ ...queuedSelection, source: queuedSelection.source === "none" ? "none" : "auto" })
      : readInputPluginScope(input.metadata.pluginScope);
    const queuedIds = queuedSelection?.status === "resolved"
      ? queuedSelection.scopeVersion === 2 ? queuedSelection.pluginIds ?? [] : queuedSelection.pluginId ? [queuedSelection.pluginId] : []
      : inputPluginId ? [inputPluginId] : queuedScope?.pluginIds ?? [];
    // Promotion joins an existing Run: both Inputs must already own the same
    // scope. It cannot borrow a wider automatic scope from a later input.
    let compatible = activeIds.length === queuedIds.length && activeIds.every(id => queuedIds.includes(id));
    if (compatible && activeIds.length && (queuedScope || activeSelection?.source === "auto")) {
      compatible = activeSelection?.scopeVersion === 2 && queuedScope?.source === "auto" &&
        activeSelection.candidates?.length === queuedScope.candidates.length &&
        queuedScope.candidates.every(candidate => activeSelection.candidates?.some(active =>
          active.pluginId === candidate.pluginId && active.version === candidate.version && active.behaviorDigest === candidate.behaviorDigest)) === true;
    }
    if ((activeIds.length || queuedIds.length) &&
      readRuntimeMetadata(this.options.durableSessions.getSession(sessionId)?.metadata).pluginsEnabled === false) compatible = false;
    if (!compatible) {
      throw new SessionApplicationError(409, "session_capability_requires_queued_run");
    }
    const content = await this.materializeSteerInput(sessionId, input.items);
    const promoted = this.options.runtime.promoteQueuedRun(
      sessionId,
      queuedRunId,
      expectedActiveRunId,
      {
        id: input.id,
        content,
        inputItems: input.items,
        delivery: "steer",
        traceId: normalizeTraceId(input.metadata?.traceId),
        metadata: {
          ...(input.metadata ?? {}),
          promotion: {
            kind: "queued_prompt",
            queuedRunId,
            expectedActiveRunId,
          },
        },
      },
    );
    if (!promoted.promoted) {
      throw new SessionApplicationError(409, "The prompt or active run changed before promotion completed");
    }
    await promoted.delivery;

    const before = this.options.events.checkpoint();
    const promotedAt = Date.now();
    const updatedQueuedRun = this.options.durableRuns.updateRun(queuedRunId, {
      status: "interrupted",
      error: "Queued prompt was promoted into the active run",
      metadata: {
        promotion: {
          kind: "steered",
          inputId,
          queuedRunId,
          activeRunId: expectedActiveRunId,
          promotedAt,
        },
      },
    });
    this.options.events.publishSince(before);
    return { input, queued_run: updatedQueuedRun, active_run: activeRun };
  }

  async awaitRun(
    sessionId: string,
    runId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AwaitSessionRunResult> {
    const initial = this.options.durableRuns.getRun(runId);
    if (!initial || initial.sessionId !== sessionId) {
      throw new Error(`Session run not found: ${runId}`);
    }
    if (initial.status === "pending" || initial.status === "running") {
      await this.waitForRun(runId, options);
    }
    const run = this.options.durableRuns.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      throw new Error(`Session run not found: ${runId}`);
    }
    if (run.status === "pending" || run.status === "running") {
      throw new Error(`Session run is still active: ${runId}`);
    }
    const output = this.options.durableInputs
      .listMessages(sessionId)
      .filter(
        (message) => message.runId === runId && message.role === "assistant",
      )
      .flatMap((message) =>
        this.options.durableInputs.listMessageParts(sessionId, {
          messageId: message.id,
        }),
      )
      .filter(isCommittedPublicTextPart)
      .map((part) => {
        if (part.text) return part.text;
        if (part.output == null) return "";
        return typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output);
      })
      .filter(Boolean)
      .join("\n");
    return {
      status: run.status,
      output,
      ...(run.error ? { error: run.error } : {}),
    };
  }

  private async waitForRun(
    runId: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    const signal = options.signal;
    if (signal?.aborted) throw this.abortError(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const guards: Promise<never>[] = [];
    if (options.timeoutMs !== undefined) {
      guards.push(new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for session run: ${runId}`)),
          options.timeoutMs,
        );
      }));
    }
    if (signal) {
      guards.push(new Promise((_, reject) => {
        onAbort = () => reject(this.abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }));
    }
    try {
      await Promise.race([this.options.runtime.waitForRun(runId), ...guards]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error(typeof signal.reason === "string" ? signal.reason : "Run wait aborted");
  }

  async waitForRuns(runIds: string[]): Promise<void> {
    await this.options.runtime.waitForRuns(runIds);
  }

  async stopGoalChildren(sessionId: string, goalId: string, objectiveVersion: number | undefined, reason: string): Promise<void> {
    const goal = this.options.goals?.getGoal?.(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new SessionApplicationError(409, "目标归属不匹配");
    const read = () => (this.options.durableRuns.listGoalRuns?.(goalId, objectiveVersion) ?? [])
      .filter((run) => typeof run.metadata.parentRunId === "string" && (run.status === "pending" || run.status === "running"));
    const active = read();
    for (const run of active) {
      await this.options.children?.interruptRun(run.sessionId, run.id, reason);
    }
    if (read().length) throw new SessionApplicationError(409, "目标子任务尚未停止，请稍后重试");
  }

  async stopAndDrain(reason = "Daemon shutting down"): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    this.accepting = false;
    const stopping = (async () => {
      const runIds: string[] = [];
      for (const sessionId of this.options.runtime.sessionIds()) {
        const interrupted = this.interruptSession(sessionId, reason);
        if (interrupted.activeRunId) runIds.push(interrupted.activeRunId);
        runIds.push(...interrupted.queuedRunIds);
      }
      await this.waitForRuns(runIds);
    })();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      // Coalesce only an in-flight drain, not future scans of newly admitted work.
      this.stopPromise = undefined;
    }
  }

  pauseGoalForRun(runId: string | undefined): void {
    const run = runId ? this.options.durableRuns.getRun(runId) : undefined;
    const goal = typeof run?.metadata?.goalId === "string" ? this.options.goals?.getGoal?.(run.metadata.goalId) : undefined;
    if (goal?.status === "active") {
      this.options.goals?.updateGoal?.(goal.id, {
        expectedRevision: goal.revision,
        status: "paused",
        reason: "用户停止了目标回合",
        stopReason: { code: "user_paused", at: Date.now(), runId },
      });
    }
  }

  private async materializeSteerInput(
    sessionId: string,
    items: SessionInputRecord["items"],
  ): Promise<string> {
    if (!items.some((item) => item.type === "skill")) return sessionUserInputText(items);
    if (!this.options.materializeSteerInput) {
      throw new Error("session_input_skill_catalog_unavailable");
    }
    return await this.options.materializeSteerInput(sessionId, items);
  }
}
