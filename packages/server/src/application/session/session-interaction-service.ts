import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
} from "@vykor/services";
import {
  sessionUserInputText,
  assertPromptMetadataAllowed,
  readRuntimeMetadata,
  type SessionInputRecord,
  type SessionRecord,
  type SessionRunRecord,
  type SessionUserInputItem,
} from "@vykor/protocol";
import { ApplicationError } from "../../shared/application-error.js";

import type {
  AdmitPromptInput,
  AdmitPromptResult,
} from "./run-admission-service.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import { isRecord, jsonEqual, withoutTraceId } from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";
import { materializeSessionInput } from "./session-input-materializer.js";
import { conversationContextCatalog } from "./session-conversation-context.js";
import { capturePluginSelectionPolicy, emptyPluginScope } from "./session-plugin-selection.js";
import type { RunControlService } from "./run-control-service.js";
import type {
  CancelQueuedPromptInput,
  EditLatestPromptInput,
  PromoteQueuedPromptInput,
  ResumeRunInput,
  ResumeRunResult,
  SessionInteractionRuns,
  SessionInteractionServiceContext,
} from "./session-interaction-types.js";

export { SessionApplicationError } from "./session-application-error.js";
export type {
  CancelQueuedPromptInput,
  EditLatestPromptInput,
  PromoteQueuedPromptInput,
  ResumeRunInput,
  ResumeRunResult,
  SessionInteractionConversations,
  SessionInteractionRuns,
  SessionInteractionServiceContext,
  SessionInteractionSessions,
} from "./session-interaction-types.js";

function inputItems(input: {
  items?: readonly SessionUserInputItem[];
  content?: string;
}): SessionUserInputItem[] {
  return input.items
    ? [...input.items]
    : [{ type: "text", text: input.content ?? "" }];
}

function withoutPluginId(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    !metadata ||
    !["pluginId", "pluginIds", "pluginSelection", "pluginSelectionPolicy", "pluginScope"].some((key) =>
      Object.hasOwn(metadata, key),
    )
  )
    return metadata;
  const sanitized = { ...metadata };
  delete sanitized.pluginId;
  delete sanitized.pluginSelection;
  delete sanitized.pluginSelectionPolicy;
  delete sanitized.pluginScope;
  delete sanitized.pluginIds;
  return sanitized;
}

/** Cross-service Prompt/Run interactions; child sessions are projected by framework events. */
export class SessionInteractionService {
  constructor(private readonly context: SessionInteractionServiceContext) {}

  private get hasRuntime(): boolean {
    return this.context.agentPool.configured;
  }

  async warmSession(sessionId: string): Promise<SessionRecord | undefined> {
    const session = this.context.sessions.get(sessionId);
    if (session && !this.context.liveChildren.has(sessionId)) {
      this.warmWhenAdmitted(session);
    }
    return session;
  }

  async editLatestPrompt(
    sessionId: string,
    input: EditLatestPromptInput,
  ): Promise<AdmitPromptResult> {
    assertPromptMetadataAllowed(input);
    return this.context.operationRunner.run(sessionId, async () => {
      const session = this.requireSession(sessionId);
      const items = inputItems(input);
      const content = sessionUserInputText(items).trim();
      const attachments = normalizePromptAttachments(input.attachments);
      if (!content && attachments.length === 0) {
        throw new SessionApplicationError(
          400,
          "content or attachments are required",
        );
      }
      const existingInput = this.context.conversations.getInput(input.id);
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
          throw new SessionApplicationError(
            409,
            `Prompt id is already used: ${input.id}`,
          );
        }
        return promptResult(this.context.runs, existingInput);
      }
      const hasPluginCandidates = items.some(
        (item) => item.type === "capability" || item.type === "skill",
      );
      const requiresPluginService = items.some(
        (item) =>
          item.type === "capability" ||
          (item.type === "skill" && item.source === "plugin"),
      );
      if (requiresPluginService && !this.context.pluginCapabilities) {
        throw new Error("session_plugin_capability_unavailable");
      }
      const capability =
        (hasPluginCandidates ||
          typeof session.metadata?.activePluginId === "string") &&
        this.context.pluginCapabilities
          ? await this.context.pluginCapabilities.admit(session, items)
          : {};
      if (this.context.control.hasWork(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Wait for the active session run before editing the latest prompt",
        );
      }
      if (this.context.liveChildren.has(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Editing a live child session is not supported",
        );
      }
      const latestUserMessage = [
        ...this.context.conversations.listMessages(sessionId),
      ]
        .reverse()
        .find((message) => message.role === "user");
      if (!latestUserMessage) {
        throw new SessionApplicationError(
          409,
          "No user prompt is available to edit",
        );
      }
      if (latestUserMessage.id !== input.sourceMessageId) {
        throw new SessionApplicationError(
          409,
          "The prompt selected for editing is no longer the latest user message",
        );
      }
      await this.context.agentPool.close(sessionId);
      const pluginScope = !capability.pluginId
        ? await this.context.pluginCapabilities?.captureScope?.(session) ?? emptyPluginScope()
        : undefined;
      return this.context.admission.replaceLatestPrompt(
        sessionId,
        latestUserMessage.id,
        {
          id: input.id,
          items,
          attachments,
          traceId: input.traceId,
          metadata: {
            ...(withoutPluginId(input.metadata) ?? {}),
            ...(capability.pluginId
              ? { pluginId: capability.pluginId }
              : {
                  pluginSelectionPolicy: capturePluginSelectionPolicy(session),
                  pluginScope,
                }),
            edit: {
              kind: "latest_prompt",
              sourceMessageId: latestUserMessage.id,
            },
          },
          ...(capability.pluginId
            ? { runMetadata: { pluginId: capability.pluginId } }
            : {}),
        },
      );
    });
  }

  async admitPrompt(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    assertPromptMetadataAllowed(input);
    const work = () => this.context.operationRunner.run(sessionId, () =>
      this.admitPromptWork(this.requireSession(sessionId), input),
    );
    return this.context.admission.withUserInputPreparation
      ? this.context.admission.withUserInputPreparation(sessionId, work) : work();
  }

  private async admitPromptWork(
    session: SessionRecord,
    originalInput: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    const sessionId = session.id;
    const items = inputItems(originalInput);
    const hasPluginCandidates = items.some(
      (item) => item.type === "capability" || item.type === "skill",
    );
    const requiresPluginService = items.some(
      (item) =>
        item.type === "capability" ||
        (item.type === "skill" && item.source === "plugin"),
    );
    if (requiresPluginService && !this.context.pluginCapabilities) {
      throw new Error("session_plugin_capability_unavailable");
    }
    const existingInput = originalInput.id
      ? this.context.conversations.getInput(originalInput.id)
      : undefined;
    // Retries keep their original selection, including an ordinary input with
    // no plugin, rather than picking up a later session selection.
    const capability = existingInput
      ? {
          pluginId:
            typeof existingInput.metadata.pluginId === "string"
              ? existingInput.metadata.pluginId
              : undefined,
        }
      : (hasPluginCandidates ||
            typeof session.metadata?.activePluginId === "string") &&
          this.context.pluginCapabilities
        ? await this.context.pluginCapabilities.admit(session, items)
        : {};
    const pluginScope = existingInput
      ? existingInput.metadata.pluginScope
      : !capability.pluginId
        ? await this.context.pluginCapabilities?.captureScope?.(session) ?? emptyPluginScope()
        : undefined;
    if (!existingInput && originalInput.delivery === "steer") {
      const activeRunId = this.context.control.activeRunId?.(sessionId);
      const activeRun = activeRunId
        ? this.context.runs.getRun(activeRunId)
        : undefined;
      const activePluginId =
        typeof activeRun?.metadata?.pluginId === "string"
          ? activeRun.metadata.pluginId
          : undefined;
      const activeSelection = isRecord(activeRun?.metadata.pluginSelection) ? activeRun.metadata.pluginSelection : undefined;
      const activePluginIds = activeSelection?.scopeVersion === 2 && Array.isArray(activeSelection.pluginIds)
        ? activeSelection.pluginIds : activePluginId ? [activePluginId] : [];
      const inheritAutomaticScope =
        !hasPluginCandidates &&
        !capability.pluginId &&
        activePluginIds.length > 0 &&
        activeSelection?.source === "auto" &&
        activeSelection.status === "resolved" &&
        readRuntimeMetadata(session.metadata).pluginsEnabled !== false;
      // Borrow only the active Run's scope. Never persist an automatic plugin
      // as an inherited Input identity if delivery later creates a new Run.
      const steerPluginId = inheritAutomaticScope
        ? activePluginId
        : capability.pluginId;
      if (
        (capability.pluginId && hasPluginCandidates) ||
        steerPluginId !== activePluginId ||
        (activeSelection?.scopeVersion === 2 && activeSelection.source === "auto" && activePluginIds.length > 0 && !inheritAutomaticScope)
      ) {
        throw new SessionApplicationError(
          409,
          "session_capability_requires_queued_run",
        );
      }
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
    const selectedInput = capability.pluginId
      ? {
          ...sanitizedInput,
          items,
          metadata: {
            ...(sanitizedInput.metadata ?? {}),
            pluginId: capability.pluginId,
          },
          runMetadata: {
            ...(sanitizedInput.runMetadata ?? {}),
            pluginId: capability.pluginId,
          },
        }
      : sanitizedInput;
    const policy = existingInput
      ? existingInput.metadata.pluginSelectionPolicy
      : !capability.pluginId
        ? capturePluginSelectionPolicy(session)
        : undefined;
    const input =
      policy === "auto" || policy === "none"
        ? {
            ...selectedInput,
            metadata: {
              ...(selectedInput.metadata ?? {}),
              pluginSelectionPolicy: policy,
              ...(pluginScope ? { pluginScope } : {}),
            },
          }
        : selectedInput;
    const delivery = input.delivery ?? "queue";
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (
      !input.pluginAppContexts?.length &&
      !hasAttachments &&
      this.context.liveChildren.has(sessionId) &&
      input.id
    ) {
      const existing = existingInput;
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          !jsonEqual(inputItems(existing), inputItems(input)) ||
          existing.delivery !== delivery ||
          !jsonEqual(
            withoutTraceId(existing.metadata),
            withoutTraceId(metadata),
          )
        ) {
          throw new SessionApplicationError(
            409,
            `Prompt id is already used: ${input.id}`,
          );
        }
        return promptResult(this.context.runs, existing);
      }
    }
    let liveContent = sessionUserInputText(items);
    if (
      !input.pluginAppContexts?.length &&
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
        conversationContextCatalog(
          {
            getSession: (id) => this.context.sessions.get(id),
            listMessages: (id) => this.context.conversations.listMessages(id),
            listMessageParts: (id) =>
              this.context.conversations.listMessageParts(id),
          },
          sessionId,
        ),
      ).instruction;
    }
    const live =
      hasAttachments || capability.pluginId || input.pluginAppContexts?.length
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
      const admitted = this.context.conversations.getInput(live.inputId);
      const run = this.context.runs.getRun(live.runId);
      const owningRun = this.context.runs.findRunByInput(live.inputId);
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
        ...(run.status === "running"
          ? { queue_state: "running" as const }
          : {}),
        ...(run.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
    return await this.context.admission.admitPromptAndMaybeRun(
      sessionId,
      input,
    );
  }

  async resumeRun(
    sessionId: string,
    runId: string,
    input: ResumeRunInput,
  ): Promise<ResumeRunResult> {
    return this.context.operationRunner.run(sessionId, async () => {
      const sourceRun = this.context.runs.getRun(runId);
      if (!sourceRun || sourceRun.sessionId !== sessionId) {
        throw new SessionApplicationError(404, "Interrupted run not found");
      }
      if (Object.hasOwn(sourceRun.metadata, "uiAction") || Object.hasOwn(sourceRun.metadata, "pluginAppAction")) {
        throw new ApplicationError(
          409,
          "插件操作不能通过继续运行重放；请检查实际结果后重新发起操作",
          "plugin_ui_action_not_resumable",
        );
      }
      if (sourceRun.status !== "interrupted") {
        throw new SessionApplicationError(
          409,
          "Only interrupted runs can be resumed",
        );
      }
      if (!sourceRun.inputId) {
        throw new SessionApplicationError(
          409,
          "This interrupted run has no prompt to replay",
        );
      }
      const sourceInput = this.context.conversations.getInput(
        sourceRun.inputId,
      );
      if (!sourceInput || sourceInput.sessionId !== sessionId) {
        throw new SessionApplicationError(
          409,
          "The original prompt is unavailable",
        );
      }

      const requestedRecovery = input.id
        ? this.context.runs.getRun(input.id)
        : undefined;
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

      const existingRecovery = this.context.runs
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
          ...(existingRecovery.status === "running"
            ? { queue_state: "running" as const }
            : {}),
          ...(existingRecovery.status === "pending"
            ? { queue_state: "queued" as const }
            : {}),
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
        throw new SessionApplicationError(
          409,
          "Session runtime is unavailable",
        );
      }
      if (this.context.control.hasWork(sessionId)) {
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
      const selection =
        isRecord(sourceRun.metadata.pluginSelection) &&
        sourceRun.metadata.pluginSelection.status === "resolved"
          ? sourceRun.metadata.pluginSelection
          : undefined;
      const pluginId = selection
        ? typeof selection.pluginId === "string"
          ? selection.pluginId
          : undefined
        : typeof sourceInput.metadata.pluginId === "string"
          ? sourceInput.metadata.pluginId
          : undefined;
      const resumed = this.context.admission.replayInput(sourceInput.id, {
        id: input.id,
        metadata: {
          ...(withoutPluginId(input.metadata) ?? {}),
          ...(pluginId ? { pluginId } : {}),
          ...(selection ? { pluginSelection: selection } : {}),
          recovery,
        },
        traceId: input.traceId,
      });
      this.context.conversations.appendEvent({
        type: "session.run.recovery_requested",
        sessionId,
        payload: {
          sourceRunId: sourceRun.id,
          sourceInputId: sourceInput.id,
          recoveryInputId: resumed.input.id,
          recoveryRunId: resumed.run?.id,
        },
      });
      return { ...resumed, source_run: sourceRun };
    });
  }

  async interruptSession(
    sessionId: string,
    expectedRunId?: string,
    source: "user" | "system" = "user",
  ): Promise<{
    activeRunId?: string;
    queuedRunIds: string[];
    interrupted: boolean;
  }> {
    return this.context.operationRunner.run(sessionId, async () => {
      if (expectedRunId) {
        const requestedAt = Date.now();
        const result = this.context.control.interruptRun(
          sessionId,
          expectedRunId,
        );
        this.recordInterruption(
          sessionId,
          result,
          requestedAt,
          source,
          expectedRunId,
        );
        return result;
      }
      const requestedAt = Date.now();
      const lane = this.context.control.interruptSession(sessionId);
      this.recordInterruption(sessionId, lane, requestedAt, source);
      const targets = [sessionId, ...this.descendantSessionIds(sessionId)];
      const childInterrupted = (
        await Promise.all(
          targets.map(async (target) => {
            // 子会话的运行可能由 live handle 管理；在停止前保存实际活动的运行 ID。
            const ids = this.context.liveChildren.has(target)
              ? [
                  ...new Set(
                    this.context.conversations
                      .listMessages(target)
                      .map((message) => message.runId),
                  ),
                ]
                  .filter((id): id is string => Boolean(id))
                  .filter((id) => {
                    const run = this.context.runs.getRun(id);
                    return (
                      run?.status === "pending" || run?.status === "running"
                    );
                  })
              : [];
            const interrupted = await this.context.liveChildren.interrupt(
              target,
              "Session interrupted",
            );
            if (interrupted)
              for (const id of ids) {
                this.recordInterruption(
                  target,
                  { interrupted: true, activeRunId: id, queuedRunIds: [] },
                  requestedAt,
                  source,
                );
              }
            return interrupted;
          }),
        )
      ).some(Boolean);
      return childInterrupted && !lane.interrupted
        ? { ...lane, interrupted: true }
        : lane;
    });
  }

  private recordInterruption(
    sessionId: string,
    result: {
      interrupted: boolean;
      activeRunId?: string;
      queuedRunIds: string[];
    },
    requestedAt: number,
    source: "user" | "system",
    targetRunId?: string,
  ): void {
    if (!result.interrupted) return;
    const ids = new Set([
      targetRunId ?? result.activeRunId,
      ...result.queuedRunIds,
    ]);
    for (const id of ids) {
      if (!id) continue;
      const run = this.context.runs.getRun(id);
      if (
        !run ||
        run.sessionId !== sessionId ||
        run.status === "completed" ||
        run.status === "failed"
      )
        continue;
      const previous = run.metadata.interruption;
      if (isRecord(previous) && previous.runId === id) continue;
      this.context.runs.updateRun(id, {
        metadata: {
          ...run.metadata,
          interruption: {
            source,
            runId: id,
            requestedAt,
            wasPending:
              !Number.isFinite(run.startedAt) &&
              (result.queuedRunIds.includes(id) || run.status === "pending"),
          },
        },
      });
    }
  }

  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    command: PromoteQueuedPromptInput,
  ): Promise<
    NonNullable<Awaited<ReturnType<RunControlService["promoteQueuedRun"]>>>
  > {
    return this.context.operationRunner.run(sessionId, async () => {
      const promoted = await this.context.control.promoteQueuedRun(
        sessionId,
        inputId,
        command.queuedRunId,
        command.expectedActiveRunId,
      );
      if (!promoted)
        throw new SessionApplicationError(
          409,
          "The prompt or active run changed before promotion completed",
        );
      return promoted;
    });
  }

  async cancelQueuedPrompt(
    sessionId: string,
    inputId: string,
    command: CancelQueuedPromptInput,
  ): Promise<{
    input: SessionInputRecord;
    run: SessionRunRecord;
  }> {
    return this.context.operationRunner.run(sessionId, async () => {
      const input = this.context.conversations.getInput(inputId);
      let run = this.context.runs.getRun(command.queuedRunId);
      if (!input || input.sessionId !== sessionId) {
        throw new SessionApplicationError(404, `Prompt not found: ${inputId}`);
      }
      if (!run || run.sessionId !== sessionId || run.inputId !== inputId) {
        throw new SessionApplicationError(
          404,
          `Queued run not found: ${command.queuedRunId}`,
        );
      }
      const cancellation = isRecord(run.metadata.cancellation)
        ? run.metadata.cancellation
        : undefined;
      if (
        run.status === "interrupted" &&
        cancellation?.kind === "user_cancelled_pending"
      ) {
        return { input, run };
      }
      if (run.status !== "pending") {
        throw new SessionApplicationError(
          409,
          "The selected prompt is no longer waiting in the queue",
        );
      }
      const interrupted = this.context.control.interruptQueuedRun(
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
      run = this.context.runs.updateRun(command.queuedRunId, {
        metadata: {
          cancellation: {
            kind: "user_cancelled_pending",
            inputId,
            cancelledAt: Date.now(),
          },
        },
      });
      return { input, run };
    });
  }

  private warmWhenAdmitted(session: Pick<SessionRecord, "id" | "cwd">): void {
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

  private descendantSessionIds(sessionId: string): string[] {
    const result: string[] = [];
    for (const child of this.context.sessions.listChildren(sessionId)) {
      result.push(child.id, ...this.descendantSessionIds(child.id));
    }
    return result;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.context.sessions.get(sessionId);
    if (!session) {
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    }
    return session;
  }
}

function promptResult(
  runs: Pick<SessionInteractionRuns, "findRunByInput">,
  input: SessionInputRecord,
): AdmitPromptResult {
  const run = runs.findRunByInput(input.id);
  return {
    input,
    ...(run ? { run } : {}),
    ...(run?.status === "running" ? { queue_state: "running" as const } : {}),
    ...(run?.status === "pending" ? { queue_state: "queued" as const } : {}),
  };
}
