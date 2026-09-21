import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type { AgentEvent, ContentBlock, StreamEvent } from "@openharness/core";
import {
  type SessionStore,
} from "@openharness/services";
import {
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  parseSessionInputItems,
  parseGoalAssessment,
  type SessionInputRecord,
} from "@openharness/protocol";

import type { ObservabilityEvent } from "../../shared/observability.js";
import type { LiveChildAgentDirectory } from "./live-child-agent-directory.js";
import type { SessionEventPublisher } from "../session/session-event-publisher.js";
import type {
  SessionChildExecutionBridge,
  SessionExecutionProjector,
} from "../session/session-execution-projector.js";
import type { ActiveTranscriptProjectionState, SessionTranscriptProjection } from "../session/transcript-projection.js";
import { isRecord, jsonEqual, withoutTraceId } from "../support.js";
import {
  decodeDaemonAgentSettlement,
  projectionSettlementInput,
  recoverProjectionSettlements,
} from "./projection-settlement-recovery.js";

interface ChildProjectionState {
  childId: string;
  sessionId: string;
  parentSessionId: string;
  parentRunId?: string;
  prompt: string;
  runId?: string;
  taskId: string;
  bridge: SessionChildExecutionBridge;
}

interface PendingEventSettlement {
  event: AgentEvent;
  action: "retry-projection" | "compensate-child";
  cause: unknown;
}

export interface DaemonAgentEventProjectorContext {
  /** Required in production; optional only for narrow projector test doubles. */
  projectorId?: string;
  rootSessionId?: string;
  rootAgent: OpenHarnessAgent;
  store: Pick<SessionStore,
    "conversations" | "conversationTransactions" | "runs" | "sessions" |
    "createProjectionSettlement" | "failProjectionSettlement" | "getProjectionSettlement" |
    "getSessionTask" | "listProjectionSettlements" | "markProjectionSettlementRetrying" |
    "resolveProjectionSettlement" | "transaction" | "updateSessionTask"
  >;
  transcriptProjection: SessionTranscriptProjection;
  executionProjector: Pick<SessionExecutionProjector, "createBridge">;
  liveChildren: Pick<LiveChildAgentDirectory, "register" | "unregister">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  log(event: ObservabilityEvent): void;
}

/**
 * 把 Agent 的 onEvent 事件写成会话记录，再推给窗口。
 *
 * 每个会话一条投影，从 daemon 的 AgentPool.onEvent 挂上来。
 * 事件来源：模型吐字、工具调用、子 Agent 活塞、用户消息、会话生命周期。
 * 投影目标：会话记录、会话状态、执行投影、会话日志、观测事件。
 */
export class DaemonAgentEventProjector {
  private readonly transcripts = new Map<string, ActiveTranscriptProjectionState>();
  private readonly children = new Map<string, ChildProjectionState>();
  private lastAppliedSequence = 0;
  private pendingSettlement?: PendingEventSettlement;

  constructor(private readonly context: DaemonAgentEventProjectorContext) { }

  async apply(event: AgentEvent): Promise<void> {
    if (this.hasDurableSettlementStore()) await this.reconcileDurableSettlements();
    else await this.reconcilePendingSettlement();
    if (event.sequence <= this.lastAppliedSequence) return;
    try {
      await this.project(event);
      this.lastAppliedSequence = event.sequence;
    } catch (error) {
      let recovered = false;
      if (event.context.childId) {
        const settlement: PendingEventSettlement = {
          event,
          action: event.type === "child.closed" ? "retry-projection" : "compensate-child",
          cause: error,
        };
        recovered = this.hasDurableSettlementStore()
          ? await this.persistAndSettle(settlement, error)
          : await this.settleInMemory(settlement);
      }
      if (recovered) return;
      throw error;
    }
  }

  private async project(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "child.created":
        await this.projectChildCreated(event);
        return;
      case "child.closed":
        await this.projectChildClosed(event);
        return;
      case "child.suspended":
      case "child.resumed":
        this.appendRuntimeEvent(event, { childId: event.data.childId, childSessionId: event.data.sessionId });
        return;
      case "input.accepted":
        this.projectInput(event);
        return;
      case "run.started":
        await this.startRun(event);
        return;
      case "output.text.delta":
        this.projectStream(event, {
          type: "text_delta",
          delta: event.data.delta,
          ...(event.data.phase ? { phase: event.data.phase } : {}),
        });
        return;
      case "output.reasoning.delta":
        this.projectStream(event, {
          type: "reasoning_delta",
          delta: event.data.delta,
          source: event.data.source,
        });
        return;
      case "output.turn.completed":
        this.projectStream(event, { type: "complete", stopReason: event.data.stopReason });
        return;
      case "tool.started":
        this.projectStream(event, { type: "tool_use_start", toolUse: event.data.toolUse });
        return;
      case "tool.completed":
        this.projectStream(event, {
          type: "tool_use_end",
          toolUseId: event.data.toolUseId,
          result: event.data.result,
        });
        return;
      case "usage.updated":
        this.projectUsage(event);
        return;
      case "domain.event":
        if (event.data.name === "goal.assessment" && event.context.runId) {
          const run = this.context.store.runs.getRun(event.context.runId);
          const payload = event.data.payload;
          if (run && run.sessionId === event.context.sessionId && typeof run.metadata.goalId === "string" && typeof run.metadata.goalRevision === "number" && run.status === "running" && !run.metadata.goalSettled && payload?.goalId === run.metadata.goalId && payload?.revision === run.metadata.goalRevision && payload?.runId === run.id) {
            try {
              const assessment = parseGoalAssessment(payload, { goalId: run.metadata.goalId, revision: run.metadata.goalRevision, runId: run.id });
              this.context.store.runs.updateRun(run.id, { metadata: { goalAssessment: assessment } });
            } catch { /* Invalid or unbound suggestions cannot change the durable goal. */ }
          }
        }
        if (event.data.name === "context_compaction") {
          const phase = event.data.payload?.phase;
          if (phase === "compact_start" || phase === "compact_end" || phase === "compact_failed") {
            const presentationPhase = phase === "compact_start" ? "started" : phase === "compact_end" ? "completed" : "failed";
            const message = this.context.store.conversations.createMessage({
              sessionId: event.context.sessionId,
              role: "system",
              metadata: { presentation: { kind: "context_compaction", phase: presentationPhase } },
            });
            this.context.store.conversations.upsertMessagePart({
              sessionId: event.context.sessionId,
              messageId: message.id,
              type: "text",
              status: "completed",
              text: presentationPhase === "started" ? "正在压缩上下文" : presentationPhase === "completed" ? "已压缩上下文" : "上下文压缩失败",
            });
          }
        }
        this.appendRuntimeEvent(event, {
          name: event.data.name,
          payload: event.data.payload ?? {},
        }, "agent.domain.event");
        return;
      case "permission.requested":
      case "permission.resolved":
        this.appendRuntimeEvent(event, { ...event.data });
        return;
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        await this.finishRun(event);
        return;
    }
  }

  private async projectChildCreated(event: Extract<AgentEvent, { type: "child.created" }>): Promise<void> {
    const { childId, sessionId, spawn, cwd, worktree } = event.data;
    const parent = this.context.store.sessions.get(event.context.sessionId);
    if (!parent) throw new Error(`Parent session not found for child ${childId}: ${event.context.sessionId}`);
    if (parent.status === "closing" || parent.status === "archived") {
      throw new Error(`Parent session is not accepting child agents: ${parent.id}`);
    }
    const existing = this.context.store.sessions.get(sessionId);
    if (
      existing &&
      (existing.parentId !== parent.id || existing.cwd !== cwd || existing.metadata.childId !== childId)
    ) {
      throw new Error(`Child session identity conflict: ${sessionId}`);
    }

    if (!existing) {
      const before = this.context.events.checkpoint();
      const parentRuntime = readSessionRuntimeConfig(parent);
      const model = spawn.model ?? parentRuntime.model;
      const runtimePatch = {
        ...parentRuntime,
        model,
        ...(spawn.systemPrompt !== undefined ? { systemPrompt: spawn.systemPrompt } : {}),
        ...(spawn.permissionMode !== undefined ? { permissionMode: spawn.permissionMode } : {}),
        ...(spawn.allowedTools !== undefined ? { allowedTools: spawn.allowedTools } : {}),
        ...(spawn.disallowedTools !== undefined ? { disallowedTools: spawn.disallowedTools } : {}),
        ...(spawn.maxTurns !== undefined ? { maxTurns: spawn.maxTurns } : {}),
        ...(isRuntimeEffort(spawn.effort) ? { effort: spawn.effort } : {}),
      };
      this.context.store.sessions.create({
        id: sessionId,
        parentId: parent.id,
        cwd,
        model,
        title: `${spawn.agent}@${spawn.team ?? "default"}`,
        agent: spawn.agent,
        metadata: patchSessionRuntimeMetadata({
          ...spawn.metadata,
          team: spawn.team ?? "default",
          isolate: spawn.isolate,
          childId,
          ...(worktree ? { worktree } : {}),
        }, runtimePatch),
      });
      this.context.events.publishSince(before);
    }

    const bridge = this.context.executionProjector.createBridge({ id: parent.id, cwd: parent.cwd });
    let taskId = this.context.store.getSessionTask(childId)?.id;
    if (!taskId) {
      taskId = childId;
      const registered = bridge.registerChildExecution({
        id: childId,
        description: spawn.description,
        cwd,
        sessionId: parent.id,
        childSessionId: sessionId,
        prompt: spawn.prompt,
        onInput: async (content) => {
          const child = this.context.rootAgent.children.get(childId);
          if (!child) throw new Error(`Live child not found: ${childId}`);
          await child.send({ content });
        },
        onStop: async () => {
          await this.context.rootAgent.children.get(childId)?.interrupt("Child agent stopped");
        },
      });
      if (registered.id !== taskId) throw new Error(`Child task identity conflict: ${registered.id}/${taskId}`);
    }
    this.context.liveChildren.register(sessionId, childId, this.context.rootAgent);
    this.children.set(childId, { childId, sessionId, parentSessionId: parent.id, parentRunId: event.context.runId, prompt: spawn.prompt, taskId, bridge });
  }

  private async projectChildClosed(event: Extract<AgentEvent, { type: "child.closed" }>): Promise<void> {
    const state = this.children.get(event.data.childId);
    await this.completeChildCloseProjection(event, state);
  }

  private projectInput(event: Extract<AgentEvent, { type: "input.accepted" }>): void {
    const sessionId = event.context.sessionId;
    const inputId = required(event.context.inputId, "inputId", event.type);
    const content = contentToText(event.data.content);
    const originalItems = event.data.inputItems === undefined
      ? undefined : parseSessionInputItems(event.data.inputItems);
    const metadata: Record<string, unknown> = {
      ...event.data.metadata,
      ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
    };
    const runId = event.context.runId;
    const transcript = runId ? this.transcripts.get(runId) : undefined;
    const transcriptSnapshot = transcript ? snapshotTranscript(transcript) : undefined;
    const before = this.context.events.checkpoint();
    try {
      this.context.store.transaction(() => {
        let input = this.context.store.conversations.getInput(inputId);
        if (!input) {
          input = this.context.store.conversationTransactions.admitPrompt({
            id: inputId,
            sessionId,
            delivery: event.data.delivery,
            items: originalItems ?? [{ type: "text", text: content }],
            metadata,
          });
        } else {
          const sameInput = originalItems
            ? jsonEqual(input.items, originalItems)
            : input.content === content;
          const promotion = isRecord(metadata.promotion) ? metadata.promotion : undefined;
          const queuedRun = typeof promotion?.queuedRunId === "string"
            ? this.context.store.runs.getRun(promotion.queuedRunId)
            : undefined;
          const executingRun =
            input.attachments?.length && runId
              ? this.context.store.runs.getRun(runId)
              : undefined;
          const attachmentRouting = isRecord(executingRun?.metadata.attachmentRouting)
            ? executingRun.metadata.attachmentRouting
            : undefined;
          const routedAttachmentExecution =
            executingRun?.sessionId === sessionId &&
            executingRun.inputId === inputId &&
            attachmentRouting?.status === "completed";
          // The executor turns selected structured skills into one model-facing
          // instruction immediately before submit.  The durable input retains
          // its readable $name markers, so the projector must not mistake that
          // intentional adapter text for an input-id collision.
          const structuredSkillExecution = originalItems !== undefined && sameInput;
          const baseMetadata = { ...metadata };
          delete baseMetadata.promotion;
          const queuedPromptPromotion =
            input.sessionId === sessionId &&
            sameInput &&
            input.delivery === "queue" &&
            event.data.delivery === "steer" &&
            promotion?.kind === "queued_prompt" &&
            promotion.expectedActiveRunId === runId &&
            queuedRun?.sessionId === sessionId &&
            queuedRun.inputId === inputId &&
            queuedRun.status === "pending" &&
            jsonEqual(withoutTraceId(input.metadata), withoutTraceId(baseMetadata));
          if (
            !queuedPromptPromotion &&
            (
              input.sessionId !== sessionId ||
              (originalItems !== undefined && !sameInput) ||
              (!routedAttachmentExecution && !structuredSkillExecution && input.content !== content) ||
              input.delivery !== event.data.delivery ||
              !jsonEqual(withoutTraceId(input.metadata), withoutTraceId(metadata))
            )
          ) {
            throw new Error(`Agent input identity conflict: ${inputId}`);
          }
        }

        if (transcript && event.data.delivery === "steer") {
          this.context.transcriptProjection.projectSteeredInputs(transcript, [input]);
        }
      });
    } catch (error) {
      if (transcript && transcriptSnapshot) restoreTranscript(transcript, transcriptSnapshot);
      throw error;
    }
    this.context.events.publishSince(before);
  }

  private async startRun(event: Extract<AgentEvent, { type: "run.started" }>): Promise<void> {
    const sessionId = event.context.sessionId;
    const runId = required(event.context.runId, "runId", event.type);
    const inputId = required(event.context.inputId, "inputId", event.type);
    const input = this.context.store.conversations.getInput(inputId);
    if (!input) throw new Error(`Agent run input not found: ${inputId}`);
    if (this.transcripts.has(runId)) {
      await this.bindChildTaskRun(event, runId);
      return;
    }

    const before = this.context.events.checkpoint();
    const transcript = this.context.store.transaction(() => {
      const existing = this.context.store.runs.getRun(runId);
      if (!existing) {
        this.context.store.runs.createRun({
          id: runId,
          sessionId,
          inputId,
          metadata: {
            ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
            ...(event.context.parentRunId ? { parentRunId: event.context.parentRunId } : {}),
          },
        });
      } else if (existing.sessionId !== sessionId || existing.inputId !== inputId) {
        throw new Error(`Agent run identity conflict: ${runId}`);
      } else if (existing.status === "completed" || existing.status === "failed" || existing.status === "interrupted") {
        throw new Error(`Agent run is already terminal: ${runId}`);
      }
      this.context.store.runs.updateRun(runId, { status: "running" });
      const existingAttempts = this.context.store.runs.listRunAttempts(runId);
      if (existingAttempts.length === 0) {
        const session = this.context.store.sessions.get(sessionId);
        if (!session) throw new Error(`Agent run session not found: ${sessionId}`);
        const runtime = readSessionRuntimeConfig(session);
        const attempt = this.context.store.runs.createRunAttempt({
          id: `attempt_${runId}_1`,
          runId,
          sequence: 1,
          provider: runtime.provider,
          model: runtime.model,
        });
        this.context.store.runs.updateRunAttempt(attempt.id, { status: "running" });
      }
      return this.context.transcriptProjection.beginRun(sessionId, inputId, runId, input);
    });
    this.transcripts.set(runId, transcript);
    this.context.log({
      level: "info",
      event: "session.run.started",
      traceId: event.context.traceId,
      sessionId,
      runId,
    });
    this.context.events.publishSince(before);

    await this.bindChildTaskRun(event, runId);
  }

  private async bindChildTaskRun(event: AgentEvent, runId: string): Promise<void> {
    if (!event.context.childId) return;
    const child = this.children.get(event.context.childId);
    if (child) {
      child.runId = runId;
      await child.bridge.bindChildExecutionRun(child.taskId, runId);
    }
  }

  private projectStream(event: AgentEvent, stream: StreamEvent): void {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    if (!state) throw new Error(`Transcript projection not started for run: ${runId}`);
    const stateSnapshot = snapshotTranscript(state);
    const direct =
      (stream.type === "text_delta" &&
        this.context.transcriptProjection.hasOpenTextPart(state) &&
        state.activeReasoningPartId === undefined) ||
      (stream.type === "reasoning_delta" && state.activeReasoningPartId !== undefined);
    const before = direct ? undefined : this.context.events.checkpoint();
    let applied: ReturnType<SessionTranscriptProjection["projectStreamEvent"]>;
    try {
      applied = direct
        ? this.context.transcriptProjection.projectStreamEvent(state, stream)
        : this.context.store.transaction(() =>
          this.context.transcriptProjection.projectStreamEvent(state, stream));
    } catch (error) {
      restoreTranscript(state, stateSnapshot);
      throw error;
    }
    if (stream.type === "tool_use_start") {
      this.context.log({
        level: "info",
        event: "session.tool.started",
        traceId: event.context.traceId,
        sessionId: event.context.sessionId,
        runId,
        toolName: stream.toolUse.name,
      });
    } else if (stream.type === "tool_use_end") {
      this.context.log({
        level: stream.result.isError ? "warn" : "info",
        event: "session.tool.completed",
        traceId: event.context.traceId,
        sessionId: event.context.sessionId,
        runId,
        toolName: applied.completedToolName,
        ...(stream.result.isError ? { error: "tool returned an error" } : {}),
      });
    }
    if (before !== undefined) this.context.events.publishSince(before);
    if (applied.liveEvent) this.context.events.publish(applied.liveEvent);
  }

  private async finishRun(
    event: Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.interrupted" }>,
  ): Promise<void> {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    const stateSnapshot = state ? snapshotTranscript(state) : undefined;
    const before = this.context.events.checkpoint();
    const interrupted = event.type === "run.interrupted";
    const failed = event.type === "run.failed";
    const error = event.type === "run.completed" ? undefined : event.data.error.message;
    try {
      this.context.store.transaction(() => {
        if (state) {
          this.context.transcriptProjection.completeOpenTextPart(
            state,
            interrupted ? "interrupted" : failed ? "failed" : "completed",
          );
          if (state.activeReasoningPartId) {
            this.context.transcriptProjection.completeOpenReasoningPart(
              state,
              interrupted ? "interrupted" : failed ? "failed" : "completed",
            );
          }
        }
        if (error) {
          this.context.store.conversations.appendEvent({
            type: interrupted ? "session.run.interrupted" : "session.run.error",
            sessionId: event.context.sessionId,
            payload: { runId, traceId: event.context.traceId, error },
          });
        }
        this.context.store.conversationTransactions.settleActiveRunAttempts(
          runId,
          interrupted ? "cancelled" : failed ? "failed" : "completed",
          error,
        );
        if (interrupted || failed) {
          this.context.transcriptProjection.finalizeRunParts(
            event.context.sessionId,
            runId,
            interrupted ? "interrupted" : "failed",
          );
        }
        this.context.store.runs.updateRun(runId, {
          status: interrupted ? "interrupted" : failed ? "failed" : "completed",
          ...(error ? { error } : {}),
          ...(event.type === "run.completed" && event.data.stopReason
            ? { metadata: { stopReason: event.data.stopReason } }
            : {}),
        });
      });
    } catch (projectionError) {
      if (state && stateSnapshot) restoreTranscript(state, stateSnapshot);
      throw projectionError;
    }
    this.context.log({
      level: failed ? "error" : interrupted ? "warn" : "info",
      event: failed ? "session.run.failed" : interrupted ? "session.run.interrupted" : "session.run.completed",
      traceId: event.context.traceId,
      sessionId: event.context.sessionId,
      runId,
      ...(error ? { error } : {}),
    });
    this.context.events.publishSince(before);
    this.transcripts.delete(runId);

    if (event.context.childId) {
      const child = this.children.get(event.context.childId);
      if (child) {
        const result = event.type === "run.completed"
          ? { status: "completed" as const, output: event.data.output }
          : {
            status: interrupted ? "interrupted" as const : "failed" as const,
            output: event.data.output ?? error ?? "",
            ...(error ? { error } : {}),
          };
        await child.bridge.completeChildExecution(child.taskId, result);
      }
    }
  }

  private appendRuntimeEvent(event: AgentEvent, payload?: Record<string, unknown>, type = `agent.${event.type}`): void {
    if (
      this.context.store.conversations.listEvents({ sessionId: event.context.sessionId }).some(
        (candidate) => candidate.type === type && candidate.payload.frameworkEventId === event.id,
      )
    ) return;
    const before = this.context.events.checkpoint();
    this.context.store.conversations.appendEvent({
      type,
      sessionId: event.context.sessionId,
      payload: { frameworkEventId: event.id, ...payload },
    });
    this.context.events.publishSince(before);
  }

  private async compensateChildProjectionFailure(event: AgentEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const runId = event.context.runId;
    if (runId) {
      const run = this.context.store.runs.getRun(runId);
      if (run && (run.status === "pending" || run.status === "running")) {
        const before = this.context.events.checkpoint();
        this.context.store.transaction(() => {
          this.context.transcriptProjection.finalizeRunParts(event.context.sessionId, runId, "failed");
          this.context.store.conversations.appendEvent({
            type: "session.run.error",
            sessionId: event.context.sessionId,
            payload: { runId, traceId: event.context.traceId, error: message, projectionFailure: true },
          });
          this.context.store.conversationTransactions.settleActiveRunAttempts(runId, "failed", message);
          this.context.store.runs.updateRun(runId, { status: "failed", error: message });
        });
        this.context.events.publishSince(before);
      }
      this.transcripts.delete(runId);
    }

    const child = this.children.get(event.context.childId!);
    if (!child) return;
    const task = this.context.store.getSessionTask(child.taskId);
    if (task && (task.status === "pending" || task.status === "running")) {
      await child.bridge.completeChildExecution(child.taskId, { status: "failed", output: message });
    }
  }

  private async compensateChildCreationFailure(event: AgentEvent, error: unknown): Promise<void> {
    const childId = event.context.childId!;
    const childSessionId = event.type === "child.created" ? event.data.sessionId : event.context.sessionId;
    const message = error instanceof Error ? error.message : String(error);
    this.context.liveChildren.unregister(childSessionId, childId);
    this.children.delete(childId);

    const task = this.context.store.getSessionTask(childId);
    const parent = this.context.store.sessions.get(event.context.sessionId);
    if (task && parent && (task.status === "pending" || task.status === "running")) {
      const bridge = this.context.executionProjector.createBridge({ id: parent.id, cwd: parent.cwd });
      await bridge.completeChildExecution(task.id, { status: "failed", output: message });
    }

    const child = this.context.store.sessions.get(childSessionId);
    if (child && child.status !== "archived") {
      const before = this.context.events.checkpoint();
      this.context.store.sessions.archive(childSessionId);
      this.context.events.publishSince(before);
    }
  }

  private async reconcilePendingSettlement(): Promise<void> {
    const pending = this.pendingSettlement;
    if (!pending) return;
    await this.settle(pending);
    this.lastAppliedSequence = Math.max(this.lastAppliedSequence, pending.event.sequence);
    if (this.pendingSettlement === pending) this.pendingSettlement = undefined;
  }

  private projectUsage(event: Extract<AgentEvent, { type: "usage.updated" }>): void {
    this.projectStream(event, { type: "usage", usage: event.data.usage });
    const runId = required(event.context.runId, "runId", event.type);
    const attempt = this.context.store.runs.listRunAttempts(runId)
      .filter((candidate) => candidate.status === "pending" || candidate.status === "running")
      .at(-1);
    if (!attempt) return;
    this.context.store.runs.updateRunAttempt(attempt.id, {
      inputTokens: (attempt.inputTokens ?? 0) + event.data.usage.inputTokens,
      outputTokens: (attempt.outputTokens ?? 0) + event.data.usage.outputTokens,
    });
  }

  private hasDurableSettlementStore(): boolean {
    return Boolean(
      this.context.projectorId &&
      this.context.rootSessionId &&
      typeof this.context.store.createProjectionSettlement === "function" &&
      typeof this.context.store.listProjectionSettlements === "function",
    );
  }

  private async persistAndSettle(pending: PendingEventSettlement, originalError: unknown): Promise<boolean> {
    let record;
    try {
      record = this.context.store.createProjectionSettlement(projectionSettlementInput(
        this.context.projectorId!,
        this.context.rootSessionId!,
        pending.event,
        pending.action === "retry-projection" ? "retry-terminal-projection" : "compensate-child",
        pending.cause,
      ));
    } catch (persistenceError) {
      throw new AggregateError(
        [originalError, persistenceError],
        `Projection failed and its settlement could not be persisted: ${pending.event.id}`,
      );
    }

    try {
      this.context.store.markProjectionSettlementRetrying(record.id);
      await this.settle(pending);
      this.context.store.resolveProjectionSettlement(record.id);
      this.lastAppliedSequence = pending.event.sequence;
      return pending.action === "retry-projection";
    } catch (settlementError) {
      const message = settlementError instanceof Error ? settlementError.message : String(settlementError);
      try {
        this.context.store.failProjectionSettlement(record.id, message);
      } catch (persistenceError) {
        throw new AggregateError(
          [originalError, settlementError, persistenceError],
          `Projection settlement failed and its pending state could not be persisted: ${record.id}`,
        );
      }
      this.context.log({
        level: "error",
        event: "session.child_projection.compensation_failed",
        traceId: pending.event.context.traceId,
        sessionId: pending.event.context.sessionId,
        runId: pending.event.context.runId,
        error: message,
      });
      return false;
    }
  }

  private async settleInMemory(pending: PendingEventSettlement): Promise<boolean> {
    try {
      await this.settle(pending);
      this.lastAppliedSequence = pending.event.sequence;
      return pending.action === "retry-projection";
    } catch (settlementError) {
      this.pendingSettlement = pending;
      this.context.log({
        level: "error",
        event: "session.child_projection.compensation_failed",
        traceId: pending.event.context.traceId,
        sessionId: pending.event.context.sessionId,
        runId: pending.event.context.runId,
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
      });
      return false;
    }
  }

  private async reconcileDurableSettlements(): Promise<void> {
    const records = this.context.store.listProjectionSettlements({
      rootSessionId: this.context.rootSessionId!,
      status: ["pending", "retrying"],
    });
    for (const record of records) {
      if (record.projector !== this.context.projectorId) {
        recoverProjectionSettlements(this.context.store, {
          projector: record.projector,
          rootSessionId: record.rootSessionId,
        });
        continue;
      }
      const { event, cause } = decodeDaemonAgentSettlement(record);
      const pending: PendingEventSettlement = {
        event,
        action: record.action === "retry-terminal-projection" ? "retry-projection" : "compensate-child",
        cause,
      };
      this.context.store.markProjectionSettlementRetrying(record.id);
      try {
        await this.settle(pending);
        this.context.store.resolveProjectionSettlement(record.id);
        this.lastAppliedSequence = Math.max(this.lastAppliedSequence, event.sequence);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.store.failProjectionSettlement(record.id, message);
        throw error;
      }
    }
    const pendingCount = this.context.store.listProjectionSettlements({
      rootSessionId: this.context.rootSessionId!,
      status: ["pending", "retrying"],
    }).length;
    if (pendingCount > 0) {
      throw new Error(
        `Projection settlement remains pending for root session ${this.context.rootSessionId}`,
      );
    }
    const resolvedSequence = this.context.store.listProjectionSettlements({
      projector: this.context.projectorId!,
      rootSessionId: this.context.rootSessionId!,
      status: "resolved",
    }).reduce((maximum, record) => Math.max(maximum, record.eventSequence), 0);
    this.lastAppliedSequence = Math.max(this.lastAppliedSequence, resolvedSequence);
  }

  private async settle(pending: PendingEventSettlement): Promise<void> {
    if (pending.action === "retry-projection") {
      await this.project(pending.event);
      return;
    }
    if (pending.event.type === "child.created") {
      await this.compensateChildCreationFailure(pending.event, pending.cause);
      return;
    }
    await this.compensateChildProjectionFailure(pending.event, pending.cause);
  }

  private async completeChildCloseProjection(
    event: Extract<AgentEvent, { type: "child.closed" }>,
    state: ChildProjectionState | undefined,
  ): Promise<void> {
    this.context.liveChildren.unregister(event.data.sessionId, event.data.childId);
    if (state) {
      if (!state.runId && event.data.result.status === "failed") {
        const inputId = `input_startup_${state.childId}`;
        const runId = `run_startup_${state.childId}`;
        const before = this.context.events.checkpoint();
        this.context.store.transaction(() => {
          if (!this.context.store.conversations.getInput(inputId)) this.context.store.conversationTransactions.admitPrompt({
            id: inputId, sessionId: state.sessionId, delivery: "queue",
            items: [{ type: "text", text: state.prompt }],
          });
          if (!this.context.store.runs.getRun(runId)) this.context.store.runs.createRun({
            id: runId, sessionId: state.sessionId, inputId,
            metadata: { parentRunId: state.parentRunId },
          });
          this.context.store.runs.updateRun(runId, { status: "failed", error: event.data.result.error ?? event.data.result.output });
        });
        this.context.events.publishSince(before);
        await state.bridge.bindChildExecutionRun(state.taskId, runId);
        state.runId = runId;
      }
      const task = this.context.store.getSessionTask(state.taskId);
      if (task && (task.status === "pending" || task.status === "running")) {
        await state.bridge.completeChildExecution(state.taskId, event.data.result);
      }
    }
    this.appendRuntimeEvent(event, {
      childId: event.data.childId,
      childSessionId: event.data.sessionId,
      result: event.data.result,
    });
    if (state) this.children.delete(state.childId);
  }
}

function isRuntimeEffort(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotTranscript(state: ActiveTranscriptProjectionState): ActiveTranscriptProjectionState {
  return { ...state, toolParts: new Map(state.toolParts) };
}

function restoreTranscript(
  state: ActiveTranscriptProjectionState,
  snapshot: ActiveTranscriptProjectionState,
): void {
  for (const key of Object.keys(state) as Array<keyof ActiveTranscriptProjectionState>) {
    delete (state as Partial<ActiveTranscriptProjectionState>)[key];
  }
  Object.assign(state, snapshot, { toolParts: new Map(snapshot.toolParts) });
}

function required(value: string | undefined, name: string, eventType: string): string {
  if (!value) throw new Error(`${eventType} is missing ${name}`);
  return value;
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}
