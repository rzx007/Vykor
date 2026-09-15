import type {
  AppendEventInput,
  SessionEventRecord,
  SessionGoal,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRunRecord,
} from "@openharness/protocol";
import { sessionUserInputText } from "@openharness/protocol";
import { normalizeTraceId } from "../support.js";

export interface RunControlDurableSessions {
  getSession(sessionId: string): { id: string; cwd?: string; status?: string } | undefined;
  listSessions(options?: { cwd?: string; includeArchived?: boolean }): Array<{ id: string; cwd?: string; status?: string }>;
}

export interface RunControlDurableRuns {
  getRun(runId: string): SessionRunRecord | undefined;
  updateRun(runId: string, update: Partial<SessionRunRecord>): SessionRunRecord;
  listRuns(sessionId: string): SessionRunRecord[];
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
  };
  promoteQueuedRun(
    sessionId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
    steerInput: any,
  ): {
    promoted: boolean;
    delivery: Promise<any>;
  };
  waitForRun(runId: string): Promise<void>;
  waitForRuns(runIds: string[]): Promise<void>;
}

export interface RunControlEvents {
  checkpoint(): number;
  publishSince(checkpoint: number): void;
}

export interface RunControlGoals {
  getGoal?(goalId: string): SessionGoal | undefined;
  updateGoal?(goalId: string, patch: { expectedRevision?: number; status: "paused"; reason: string }): SessionGoal | undefined;
  markGoalContinuation?(runId: string, status: "cancelled" | "running" | "completed" | "failed"): void;
}

export interface RunControlAdmissionQuery {
  hasPendingAdmission?(sessionId: string): boolean;
}

export interface RunControlServiceOptions {
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
    this.pauseGoalForRun(this.activeRunId(sessionId));
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
    return result;
  }

  interruptRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): { activeRunId?: string; queuedRunIds: string[]; interrupted: boolean } {
    const before = this.options.events.checkpoint();
    if (this.activeRunId(sessionId) === runId) this.pauseGoalForRun(runId);
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
    return result;
  }

  interruptQueuedRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): { queuedRunIds: string[] } {
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
    const activeRun = this.options.durableRuns.getRun(expectedActiveRunId);
    if (
      !input || input.sessionId !== sessionId ||
      !queuedRun || queuedRun.sessionId !== sessionId ||
      queuedRun.inputId !== inputId || queuedRun.status !== "pending"
    ) return undefined;
    if (typeof input.metadata?.pluginId === "string") {
      throw new Error("session_capability_requires_queued_run");
    }
    if (
      !activeRun || activeRun.sessionId !== sessionId ||
      (activeRun.status !== "pending" && activeRun.status !== "running") ||
      this.options.runtime.activeRunId(sessionId) !== expectedActiveRunId
    ) return undefined;
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
    if (!promoted.promoted) return undefined;
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
  ): Promise<AwaitSessionRunResult> {
    const initial = this.options.durableRuns.getRun(runId);
    if (!initial || initial.sessionId !== sessionId) {
      throw new Error(`Session run not found: ${runId}`);
    }
    if (initial.status === "pending" || initial.status === "running") {
      await this.options.runtime.waitForRun(runId);
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

  async waitForRuns(runIds: string[]): Promise<void> {
    await this.options.runtime.waitForRuns(runIds);
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
    await stopping;
  }

  pauseGoalForRun(runId: string | undefined): void {
    const run = runId ? this.options.durableRuns.getRun(runId) : undefined;
    const goal = typeof run?.metadata?.goalId === "string" ? this.options.goals?.getGoal?.(run.metadata.goalId) : undefined;
    if (goal?.status === "active") {
      this.options.goals?.updateGoal?.(goal.id, {
        expectedRevision: goal.revision,
        status: "paused",
        reason: "用户停止了目标回合",
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
