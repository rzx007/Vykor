import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  type SessionStore,
} from "@openharness/services";
import {
  sessionUserInputText,
  type AdmitPromptAttachmentInput,
  type SessionUserInputItem,
} from "@openharness/protocol";

import type {
  AdmitPromptInput,
  AdmitPromptResult,
  AwaitSessionRunResult,
  SessionRunEngine,
} from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import { isRecord, jsonEqual, withoutTraceId } from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";
import type { ContextUsageCache } from "../context-usage-cache.js";
import { materializeSessionInput } from "./session-input-materializer.js";
import { conversationContextCatalog } from "./session-conversation-context.js";
import type { SessionRunExecutorContext } from "./session-run-executor.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";
import { SessionQueryService } from "./session-query-service.js";
import {
  SessionCommandService,
  type CreateSessionCommand,
  type ForkSessionCommand,
  type UpdateSessionCommand,
} from "./session-command-service.js";

export { SessionApplicationError } from "./session-application-error.js";
export type { CreateSessionCommand, ForkSessionCommand, UpdateSessionCommand } from "./session-command-service.js";

export interface SessionApplicationServiceContext {
  store: SessionStore;
  runEngine: SessionRunEngine;
  agentPool: AgentPool;
  liveChildren: Pick<LiveChildAgentDirectory, "has" | "send" | "interrupt">;
  operationGate: Pick<DaemonOperationGate, "enter" | "tryEnterBarrier">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  /** 应用启动恢复完成前，拒绝新的写操作。测试和独立服务可不提供。 */
  assertReady?(): void;
  /** Optional: invalidate session context-usage cache on model/runtime changes. */
  contextUsageCache?: Pick<ContextUsageCache, "invalidate">;
  resolveSkillCatalog?: SessionRunExecutorContext["resolveSkillCatalog"];
  pluginCapabilities?: Pick<SessionPluginCapabilityService, "admit">;
  queries?: SessionQueryService;
  commands?: SessionCommandService;
}

export interface EditLatestPromptCommand {
  id: string;
  items: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
  sourceMessageId: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

function inputItems(input: {
  items?: readonly SessionUserInputItem[];
  content?: string;
}): SessionUserInputItem[] {
  return input.items ? [...input.items] : [{ type: "text", text: input.content ?? "" }];
}

function withoutPluginId(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !Object.hasOwn(metadata, "pluginId")) return metadata;
  const sanitized = { ...metadata };
  delete sanitized.pluginId;
  return sanitized;
}

export interface ResumeSessionRunCommand {
  id?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export interface PromoteQueuedPromptCommand {
  queuedRunId: string;
  expectedActiveRunId: string;
}

export interface CancelQueuedPromptCommand {
  queuedRunId: string;
}

export type ResumeSessionRunResult = AdmitPromptResult & {
  source_run: NonNullable<ReturnType<SessionStore["getRun"]>>;
};

/** Session 写用例门面；child session 只由 framework 事件投影创建。 */
export class SessionApplicationService {
  private readonly queries: SessionQueryService;
  private readonly commands: SessionCommandService;

  constructor(private readonly context: SessionApplicationServiceContext) {
    this.commands =
      context.commands ??
      new SessionCommandService({
        sessions: context.store,
        transactions: context.store,
        runtimeControl: {
          closeAgent: (id) => context.agentPool.close(id),
          hasActiveWorkForSession: (id) => context.agentPool.hasActiveWorkForSession(id),
          interruptSession: (id) => context.runEngine.interruptSession(id),
          waitForRuns: (ids) => context.runEngine.waitForRuns(ids),
          hasRunWork: (id) => context.runEngine.hasWork(id),
          interruptLiveChild: (id, reason) => context.liveChildren.interrupt(id, reason),
          hasLiveChild: (id) => context.liveChildren.has(id),
          warmSession: (session) => this.warmWhenAdmitted(session),
        },
        operationGate: context.operationGate,
        events: context.events,
        contextUsageCache: context.contextUsageCache,
        assertReady: context.assertReady,
      });
    this.queries = context.queries ?? new SessionQueryService(context.store);
  }

  get hasRuntime(): boolean {
    return this.context.agentPool.configured;
  }

  createSession(
    input: Parameters<SessionStore["createSession"]>[0],
  ): ReturnType<SessionStore["createSession"]> {
    return this.commands.createSession(input);
  }

  getSession(
    sessionId: string,
    options: { warm?: boolean } = {},
  ): ReturnType<SessionStore["getSession"]> {
    const session = this.queries.getSession(sessionId);
    if (session && options.warm && !this.context.liveChildren.has(sessionId)) {
      this.warmWhenAdmitted(session);
    }
    return session;
  }

  forkSession(
    sessionId: string,
    input: ForkSessionCommand = {},
  ): ReturnType<SessionStore["createSession"]> {
    return this.commands.forkSession(sessionId, input);
  }

  async editLatestPrompt(
    sessionId: string,
    input: EditLatestPromptCommand,
  ): Promise<AdmitPromptResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const items = inputItems(input);
    const content = sessionUserInputText(items).trim();
    const attachments = normalizePromptAttachments(input.attachments);
    if (!content && attachments.length === 0) {
      throw new SessionApplicationError(400, "content or attachments are required");
    }
    const lease = this.enterSessionOperation(session);
    try {
      const existingInput = this.context.store.getInput(input.id);
      if (existingInput) {
        const edit = isRecord(existingInput.metadata.edit)
          ? existingInput.metadata.edit
          : undefined;
        if (
          existingInput.sessionId !== sessionId ||
          !jsonEqual(inputItems(existingInput), items) ||
          promptAttachmentFingerprint(
            existingInput.attachments.map((reference) => ({
              assetId: reference.assetId,
              intent: reference.intent,
              ...(typeof reference.metadata.requestedDisplayName === "string"
                ? { displayName: reference.metadata.requestedDisplayName }
                : {}),
            })),
          ) !== promptAttachmentFingerprint(attachments) ||
          edit?.kind !== "latest_prompt" ||
          edit.sourceMessageId !== input.sourceMessageId
        ) {
          throw new SessionApplicationError(409, `Prompt id is already used: ${input.id}`);
        }
        return promptResult(this.context.store, existingInput);
      }
      const hasPluginCandidates = items.some((item) =>
        item.type === "capability" || item.type === "skill"
      );
      const requiresPluginService = items.some((item) =>
        item.type === "capability" || (item.type === "skill" && item.source === "plugin")
      );
      if (requiresPluginService && !this.context.pluginCapabilities) {
        throw new Error("session_plugin_capability_unavailable");
      }
      const capability = hasPluginCandidates && this.context.pluginCapabilities
        ? await this.context.pluginCapabilities.admit(session, items)
        : {};
      if (this.context.runEngine.hasWork(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Wait for the active session run before editing the latest prompt",
        );
      }
      if (this.context.liveChildren.has(sessionId)) {
        throw new SessionApplicationError(409, "Editing a live child session is not supported");
      }
      const latestUserMessage = [...this.context.store.listMessages(sessionId)]
        .reverse()
        .find((message) => message.role === "user");
      if (!latestUserMessage) {
        throw new SessionApplicationError(409, "No user prompt is available to edit");
      }
      if (latestUserMessage.id !== input.sourceMessageId) {
        throw new SessionApplicationError(
          409,
          "The prompt selected for editing is no longer the latest user message",
        );
      }
      await this.context.agentPool.close(sessionId);
      return this.context.runEngine.replaceLatestPrompt(sessionId, latestUserMessage.id, {
        id: input.id,
        items,
        attachments,
        traceId: input.traceId,
        metadata: {
          ...(withoutPluginId(input.metadata) ?? {}),
          ...(capability.pluginId ? { pluginId: capability.pluginId } : {}),
          edit: {
            kind: "latest_prompt",
            sourceMessageId: latestUserMessage.id,
          },
        },
        ...(capability.pluginId
          ? { runMetadata: { pluginId: capability.pluginId } }
          : {}),
      });
    } finally {
      lease.release();
    }
  }

  async updateSession(
    sessionId: string,
    input: UpdateSessionCommand,
  ): Promise<ReturnType<SessionStore["updateSession"]>> {
    return await this.commands.updateSession(sessionId, input);
  }

  async withSessionOperation<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      return await work();
    } finally {
      lease.release();
    }
  }

  async admitPrompt(sessionId: string, input: AdmitPromptInput): Promise<AdmitPromptResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      return await this.admitPromptWork(session, input);
    } finally {
      lease.release();
    }
  }

  private async admitPromptWork(
    session: NonNullable<ReturnType<SessionStore["getSession"]>>,
    originalInput: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    const sessionId = session.id;
    const items = inputItems(originalInput);
    const hasPluginCandidates = items.some((item) =>
      item.type === "capability" || item.type === "skill"
    );
    const requiresPluginService = items.some((item) =>
      item.type === "capability" || (item.type === "skill" && item.source === "plugin")
    );
    if (requiresPluginService && !this.context.pluginCapabilities) {
      throw new Error("session_plugin_capability_unavailable");
    }
    const existingPluginId = hasPluginCandidates && originalInput.id
      ? this.context.store.getInput(originalInput.id)?.metadata.pluginId
      : undefined;
    const capability = hasPluginCandidates && this.context.pluginCapabilities
      ? typeof existingPluginId === "string"
        ? { pluginId: existingPluginId }
        : await this.context.pluginCapabilities.admit(session, items)
      : {};
    if (capability.pluginId && originalInput.delivery === "steer") {
      throw new SessionApplicationError(409, "session_capability_requires_queued_run");
    }
    const sanitizedInput = {
      ...originalInput,
      ...(originalInput.metadata
        ? { metadata: withoutPluginId(originalInput.metadata) }
        : {}),
      ...(originalInput.runMetadata
        ? { runMetadata: withoutPluginId(originalInput.runMetadata) }
        : {}),
    };
    const input = capability.pluginId
      ? {
          ...sanitizedInput,
          items,
          metadata: { ...(sanitizedInput.metadata ?? {}), pluginId: capability.pluginId },
          runMetadata: { ...(sanitizedInput.runMetadata ?? {}), pluginId: capability.pluginId },
        }
      : sanitizedInput;
    const delivery = input.delivery ?? "queue";
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (!hasAttachments && this.context.liveChildren.has(sessionId) && input.id) {
      const existing = this.context.store.getInput(input.id);
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          !jsonEqual(inputItems(existing), inputItems(input)) ||
          existing.delivery !== delivery ||
          !jsonEqual(withoutTraceId(existing.metadata), withoutTraceId(metadata))
        ) {
          throw new SessionApplicationError(409, `Prompt id is already used: ${input.id}`);
        }
        return promptResult(this.context.store, existing);
      }
    }
    let liveContent = sessionUserInputText(items);
    if (
      !hasAttachments &&
      this.context.liveChildren.has(sessionId) &&
      items.some((item) => item.type === "skill" || item.type === "context")
    ) {
      const hasExplicitSkills = items.some((item) => item.type === "skill");
      if (hasExplicitSkills && !this.context.resolveSkillCatalog)
        throw new Error("session_input_skill_catalog_unavailable");
      liveContent = materializeSessionInput(
        items,
        hasExplicitSkills
          ? await this.context.resolveSkillCatalog!(session)
          : { resolvePath: () => undefined },
        conversationContextCatalog(this.context.store, sessionId),
      ).instruction;
    }
    const live = hasAttachments || capability.pluginId
      ? undefined
      : await this.context.liveChildren.send(sessionId, {
          id: input.id,
          content: liveContent,
          inputItems: items,
          delivery,
          traceId: input.traceId,
          metadata: input.metadata,
        });
    if (live) {
      const admitted = this.context.store.getInput(live.inputId);
      const run = this.context.store.getRun(live.runId);
      const owningRun = this.context.store.findRunByInput(live.inputId);
      if (
        live.sessionId !== sessionId ||
        !admitted ||
        admitted.sessionId !== sessionId ||
        !jsonEqual(inputItems(admitted), inputItems(input)) ||
        admitted.delivery !== delivery ||
        (input.id !== undefined && admitted.id !== input.id) ||
        !jsonEqual(withoutTraceId(admitted.metadata), withoutTraceId(metadata))
      ) {
        throw new SessionApplicationError(
          500,
          "Live child input projection did not match its framework receipt",
        );
      }
      if (
        !run ||
        run.sessionId !== sessionId ||
        !owningRun ||
        owningRun.id !== run.id ||
        owningRun.sessionId !== sessionId
      ) {
        throw new SessionApplicationError(
          500,
          "Live child run projection did not match its framework receipt",
        );
      }
      return {
        input: admitted,
        run,
        ...(run.status === "running" ? { queue_state: "running" as const } : {}),
        ...(run.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
    return await this.context.runEngine.admitPromptAndMaybeRun(sessionId, input);
  }

  async resumeRun(
    sessionId: string,
    runId: string,
    input: ResumeSessionRunCommand,
  ): Promise<ResumeSessionRunResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      const sourceRun = this.context.store.getRun(runId);
      if (!sourceRun || sourceRun.sessionId !== sessionId) {
        throw new SessionApplicationError(404, "Interrupted run not found");
      }
      if (sourceRun.status !== "interrupted") {
        throw new SessionApplicationError(409, "Only interrupted runs can be resumed");
      }
      if (!sourceRun.inputId) {
        throw new SessionApplicationError(409, "This interrupted run has no prompt to replay");
      }
      const sourceInput = this.context.store.getInput(sourceRun.inputId);
      if (!sourceInput || sourceInput.sessionId !== sessionId) {
        throw new SessionApplicationError(409, "The original prompt is unavailable");
      }

      const requestedRecovery = input.id ? this.context.store.getRun(input.id) : undefined;
      if (requestedRecovery) {
        const requestedLink = isRecord(requestedRecovery.metadata.recovery)
          ? requestedRecovery.metadata.recovery
          : undefined;
        if (
          requestedRecovery.sessionId !== sessionId ||
          requestedRecovery.inputId !== sourceInput.id ||
          requestedLink?.sourceRunId !== sourceRun.id
        ) {
          throw new SessionApplicationError(
            409,
            `Recovery run id is already used: ${requestedRecovery.id}`,
          );
        }
      }

      const existingRecovery = this.context.store
        .listRunsByInput(sourceInput.id)
        .find(
          (candidate) =>
            isRecord(candidate.metadata.recovery) &&
            candidate.metadata.recovery.sourceRunId === sourceRun.id,
        );
      if (existingRecovery && (!input.id || existingRecovery.id === input.id)) {
        return {
          input: sourceInput,
          run: existingRecovery,
          ...(existingRecovery.status === "running" ? { queue_state: "running" as const } : {}),
          ...(existingRecovery.status === "pending" ? { queue_state: "queued" as const } : {}),
          source_run: sourceRun,
        };
      }
      if (existingRecovery) {
        throw new SessionApplicationError(
          409,
          `Interrupted run already has a recovery: ${sourceRun.id}`,
        );
      }
      if (!this.hasRuntime) {
        throw new SessionApplicationError(409, "Session runtime is unavailable");
      }
      if (this.context.runEngine.hasWork(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Wait for the active session run before resuming interrupted work",
        );
      }

      const recovery = {
        kind: "prompt_replay",
        sourceRunId: sourceRun.id,
        sourceInputId: sourceInput.id,
      };
      const pluginId = typeof sourceInput.metadata.pluginId === "string"
        ? sourceInput.metadata.pluginId
        : undefined;
      const resumed = this.context.runEngine.replayInput(sourceInput.id, {
        id: input.id,
        metadata: {
          ...(withoutPluginId(input.metadata) ?? {}),
          ...(pluginId ? { pluginId } : {}),
          recovery,
        },
        traceId: input.traceId,
      });
      const before = this.context.events.checkpoint();
      this.context.store.appendEvent({
        type: "session.run.recovery_requested",
        sessionId,
        payload: {
          sourceRunId: sourceRun.id,
          sourceInputId: sourceInput.id,
          recoveryInputId: resumed.input.id,
          recoveryRunId: resumed.run?.id,
        },
      });
      this.context.events.publishSince(before);
      return { ...resumed, source_run: sourceRun };
    } finally {
      lease.release();
    }
  }

  async interruptSession(
    sessionId: string,
    expectedRunId?: string,
  ): Promise<ReturnType<SessionRunEngine["interruptSession"]>> {
    this.assertReady();
    if (expectedRunId) return this.context.runEngine.interruptRun(sessionId, expectedRunId);
    const lane = this.context.runEngine.interruptSession(sessionId);
    const targets = [sessionId, ...this.descendantSessionIds(sessionId)];
    const childInterrupted = (
      await Promise.all(
        targets.map((target) => this.context.liveChildren.interrupt(target, "Session interrupted")),
      )
    ).some(Boolean);
    return childInterrupted && !lane.interrupted ? { ...lane, interrupted: true } : lane;
  }

  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    command: PromoteQueuedPromptCommand,
  ): Promise<NonNullable<Awaited<ReturnType<SessionRunEngine["promoteQueuedRun"]>>>> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      const input = this.context.store.getInput(inputId);
      const queuedRun = this.context.store.getRun(command.queuedRunId);
      if (!input || input.sessionId !== sessionId) {
        throw new SessionApplicationError(404, `Prompt not found: ${inputId}`);
      }
      if (typeof input.metadata.pluginId === "string") {
        throw new SessionApplicationError(409, "session_capability_requires_queued_run");
      }
      if (input.attachments.length > 0) {
        throw new AttachmentError(
          "attachment_structured_steer_unsupported",
          "Queued prompts with attachments cannot be promoted during stage two",
        );
      }
      if (!queuedRun || queuedRun.sessionId !== sessionId) {
        throw new SessionApplicationError(404, `Session run not found: ${command.queuedRunId}`);
      }
      const promotion = isRecord(queuedRun.metadata.promotion)
        ? queuedRun.metadata.promotion
        : undefined;
      if (
        queuedRun.status === "interrupted" &&
        promotion?.kind === "steered" &&
        promotion.inputId === inputId &&
        typeof promotion.activeRunId === "string"
      ) {
        const activeRun = this.context.store.getRun(promotion.activeRunId);
        if (!activeRun) {
          throw new SessionApplicationError(
            409,
            "The promoted prompt no longer has its target run",
          );
        }
        return { input, queued_run: queuedRun, active_run: activeRun };
      }
      if (
        input.delivery !== "queue" ||
        queuedRun.inputId !== inputId ||
        queuedRun.status !== "pending"
      ) {
        throw new SessionApplicationError(
          409,
          "The selected prompt is no longer waiting in the queue",
        );
      }
      if (this.context.runEngine.activeRunId(sessionId) !== command.expectedActiveRunId) {
        throw new SessionApplicationError(
          409,
          "The active run changed before the prompt could be promoted",
        );
      }
      const promoted = await this.context.runEngine.promoteQueuedRun(
        sessionId,
        inputId,
        command.queuedRunId,
        command.expectedActiveRunId,
      );
      if (!promoted) {
        throw new SessionApplicationError(
          409,
          "The prompt or active run changed before promotion completed",
        );
      }
      return promoted;
    } finally {
      lease.release();
    }
  }

  async cancelQueuedPrompt(
    sessionId: string,
    inputId: string,
    command: CancelQueuedPromptCommand,
  ): Promise<{
    input: NonNullable<ReturnType<SessionStore["getInput"]>>;
    run: NonNullable<ReturnType<SessionStore["getRun"]>>;
  }> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      const input = this.context.store.getInput(inputId);
      let run = this.context.store.getRun(command.queuedRunId);
      if (!input || input.sessionId !== sessionId) {
        throw new SessionApplicationError(404, `Prompt not found: ${inputId}`);
      }
      if (!run || run.sessionId !== sessionId || run.inputId !== inputId) {
        throw new SessionApplicationError(404, `Queued run not found: ${command.queuedRunId}`);
      }
      const cancellation = isRecord(run.metadata.cancellation)
        ? run.metadata.cancellation
        : undefined;
      if (run.status === "interrupted" && cancellation?.kind === "user_cancelled_pending") {
        return { input, run };
      }
      if (run.status !== "pending") {
        throw new SessionApplicationError(
          409,
          "The selected prompt is no longer waiting in the queue",
        );
      }
      const interrupted = this.context.runEngine.interruptQueuedRun(
        sessionId,
        command.queuedRunId,
        "Queued prompt cancelled by the user",
      );
      if (!interrupted.queuedRunIds.includes(command.queuedRunId)) {
        throw new SessionApplicationError(
          409,
          "The queued prompt changed before it could be cancelled",
        );
      }
      const before = this.context.events.checkpoint();
      run = this.context.store.updateRun(command.queuedRunId, {
        metadata: {
          cancellation: {
            kind: "user_cancelled_pending",
            inputId,
            cancelledAt: Date.now(),
          },
        },
      });
      this.context.events.publishSince(before);
      return { input, run };
    } finally {
      lease.release();
    }
  }

  async awaitRun(sessionId: string, runId: string): Promise<AwaitSessionRunResult> {
    return await this.context.runEngine.awaitRun(sessionId, runId);
  }

  async closeRuntime(sessionId: string): Promise<void> {
    return await this.commands.closeRuntime(sessionId);
  }

  async archiveSessionTree(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    return await this.commands.archiveSessionTree(sessionId);
  }

  async deleteSessionTree(sessionId: string): Promise<string[]> {
    return await this.commands.deleteSessionTree(sessionId);
  }

  private enterSessionOperation(
    session: Pick<NonNullable<ReturnType<SessionStore["getSession"]>>, "id" | "cwd">,
  ): DaemonOperationLease {
    try {
      return this.context.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) {
        throw new SessionApplicationError(409, error.message);
      }
      throw error;
    }
  }

  private warmWhenAdmitted(
    session: Pick<NonNullable<ReturnType<SessionStore["getSession"]>>, "id" | "cwd">,
  ): void {
    let lease: DaemonOperationLease;
    try {
      lease = this.context.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) return;
      throw error;
    }
    void this.context.agentPool.warm(session.id).finally(() => lease.release());
  }

  private assertReady(): void {
    this.context.assertReady?.();
  }

  private descendantSessionIds(sessionId: string): string[] {
    const result: string[] = [];
    for (const child of this.context.store.listChildSessions(sessionId)) {
      result.push(child.id, ...this.descendantSessionIds(child.id));
    }
    return result;
  }
}

function promptResult(
  store: SessionStore,
  input: NonNullable<ReturnType<SessionStore["getInput"]>>,
): AdmitPromptResult {
  const run = store.findRunByInput(input.id);
  return {
    input,
    ...(run ? { run } : {}),
    ...(run?.status === "running" ? { queue_state: "running" as const } : {}),
    ...(run?.status === "pending" ? { queue_state: "queued" as const } : {}),
  };
}
