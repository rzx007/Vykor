import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
} from "@openharness/services";
import {
  sessionUserInputText,
  type AdmitPromptAttachmentInput,
  type AppendEventInput,
  type SessionInputRecord,
  type SessionMessagePartRecord,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionRunRecord,
  type SessionUserInputItem,
} from "@openharness/protocol";

import type {
  AdmitPromptInput,
  AdmitPromptResult,
} from "./session-run-engine.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import { isRecord, jsonEqual, withoutTraceId } from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";
import { materializeSessionInput } from "./session-input-materializer.js";
import { conversationContextCatalog } from "./session-conversation-context.js";
import type { SessionRunExecutorContext } from "./session-run-executor.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";
import type { RunAdmissionService } from "./run-admission-service.js";
import type { RunControlService } from "./run-control-service.js";
import type { SessionOperationRunner } from "./session-operation-runner.js";

export { SessionApplicationError } from "./session-application-error.js";

export interface SessionInteractionSessions {
  get(sessionId: string): SessionRecord | undefined;
  listChildren(sessionId: string): SessionRecord[];
}

export interface SessionInteractionConversations {
  getInput(inputId: string): SessionInputRecord | undefined;
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(sessionId: string): SessionMessagePartRecord[];
  appendEvent(input: AppendEventInput): unknown;
}

export interface SessionInteractionRuns {
  getRun(runId: string): SessionRunRecord | undefined;
  findRunByInput(inputId: string): SessionRunRecord | undefined;
  listRunsByInput(inputId: string): SessionRunRecord[];
  updateRun(runId: string, input: Partial<SessionRunRecord>): SessionRunRecord;
}

export interface SessionInteractionServiceContext {
  sessions: SessionInteractionSessions;
  conversations: SessionInteractionConversations;
  runs: SessionInteractionRuns;
  admission: Pick<RunAdmissionService, "admitPromptAndMaybeRun" | "replaceLatestPrompt" | "replayInput">;
  control: Pick<RunControlService, "hasWork" | "interruptRun" | "interruptSession" | "interruptQueuedRun" | "promoteQueuedRun">;
  operationRunner: Pick<SessionOperationRunner, "run">;
  agentPool: Pick<AgentPool, "close" | "configured" | "warm">;
  liveChildren: Pick<LiveChildAgentDirectory, "has" | "send" | "interrupt">;
  operationGate: Pick<DaemonOperationGate, "enter">;
  resolveSkillCatalog?: SessionRunExecutorContext["resolveSkillCatalog"];
  pluginCapabilities?: Pick<SessionPluginCapabilityService, "admit">;
}

export interface EditLatestPromptInput {
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

export interface ResumeRunInput {
  id?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export interface PromoteQueuedPromptInput {
  queuedRunId: string;
  expectedActiveRunId: string;
}

export interface CancelQueuedPromptInput {
  queuedRunId: string;
}

export type ResumeRunResult = AdmitPromptResult & {
  source_run: SessionRunRecord;
};

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
    return this.context.operationRunner.run(sessionId, async () => {
      const session = this.requireSession(sessionId);
      const items = inputItems(input);
      const content = sessionUserInputText(items).trim();
      const attachments = normalizePromptAttachments(input.attachments);
      if (!content && attachments.length === 0) {
        throw new SessionApplicationError(400, "content or attachments are required");
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
          throw new SessionApplicationError(409, `Prompt id is already used: ${input.id}`);
        }
        return promptResult(this.context.runs, existingInput);
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
      if (this.context.control.hasWork(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Wait for the active session run before editing the latest prompt",
        );
      }
      if (this.context.liveChildren.has(sessionId)) {
        throw new SessionApplicationError(409, "Editing a live child session is not supported");
      }
      const latestUserMessage = [...this.context.conversations.listMessages(sessionId)]
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
      return this.context.admission.replaceLatestPrompt(sessionId, latestUserMessage.id, {
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
    });
  }

  async admitPrompt(sessionId: string, input: AdmitPromptInput): Promise<AdmitPromptResult> {
    return this.context.operationRunner.run(sessionId, () =>
      this.admitPromptWork(this.requireSession(sessionId), input),
    );
  }

  private async admitPromptWork(
    session: SessionRecord,
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
      ? this.context.conversations.getInput(originalInput.id)?.metadata.pluginId
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
      const existing = this.context.conversations.getInput(input.id);
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          !jsonEqual(inputItems(existing), inputItems(input)) ||
          existing.delivery !== delivery ||
          !jsonEqual(withoutTraceId(existing.metadata), withoutTraceId(metadata))
        ) {
          throw new SessionApplicationError(409, `Prompt id is already used: ${input.id}`);
        }
        return promptResult(this.context.runs, existing);
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
        conversationContextCatalog(
          {
            getSession: (id) => this.context.sessions.get(id),
            listMessages: (id) => this.context.conversations.listMessages(id),
            listMessageParts: (id) => this.context.conversations.listMessageParts(id),
          },
          sessionId,
        ),
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
        ...(run.status === "running" ? { queue_state: "running" as const } : {}),
        ...(run.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
    return await this.context.admission.admitPromptAndMaybeRun(sessionId, input);
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
      if (sourceRun.status !== "interrupted") {
        throw new SessionApplicationError(409, "Only interrupted runs can be resumed");
      }
      if (!sourceRun.inputId) {
        throw new SessionApplicationError(409, "This interrupted run has no prompt to replay");
      }
      const sourceInput = this.context.conversations.getInput(sourceRun.inputId);
      if (!sourceInput || sourceInput.sessionId !== sessionId) {
        throw new SessionApplicationError(409, "The original prompt is unavailable");
      }

      const requestedRecovery = input.id ? this.context.runs.getRun(input.id) : undefined;
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
      const pluginId = typeof sourceInput.metadata.pluginId === "string"
        ? sourceInput.metadata.pluginId
        : undefined;
      const resumed = this.context.admission.replayInput(sourceInput.id, {
        id: input.id,
        metadata: {
          ...(withoutPluginId(input.metadata) ?? {}),
          ...(pluginId ? { pluginId } : {}),
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
  ): Promise<{ activeRunId?: string; queuedRunIds: string[]; interrupted: boolean }> {
    return this.context.operationRunner.run(sessionId, async () => {
      if (expectedRunId) {
        return this.context.control.interruptRun(sessionId, expectedRunId);
      }
      const lane = this.context.control.interruptSession(sessionId);
      const targets = [sessionId, ...this.descendantSessionIds(sessionId)];
      const childInterrupted = (
        await Promise.all(
          targets.map((target) =>
            this.context.liveChildren.interrupt(target, "Session interrupted"),
          ),
        )
      ).some(Boolean);
      return childInterrupted && !lane.interrupted
        ? { ...lane, interrupted: true }
        : lane;
    });
  }

  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    command: PromoteQueuedPromptInput,
  ): Promise<NonNullable<Awaited<ReturnType<RunControlService["promoteQueuedRun"]>>>> {
    return this.context.operationRunner.run(sessionId, async () => {
      const promoted = await this.context.control.promoteQueuedRun(
        sessionId,
        inputId,
        command.queuedRunId,
        command.expectedActiveRunId,
      );
      if (!promoted) throw new SessionApplicationError(409, "The prompt or active run changed before promotion completed");
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

  private warmWhenAdmitted(
    session: Pick<SessionRecord, "id" | "cwd">,
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
