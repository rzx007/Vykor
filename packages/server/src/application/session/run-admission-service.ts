import { randomUUID } from "node:crypto";
import {
  sessionUserInputText,
  type AdmitPromptAttachmentInput,
  type AttachmentLimits,
  type ReplaceTranscriptMessageInput,
  type SessionInputRecord,
  type SessionRunRecord,
  type SessionUserInputItem,
} from "@openharness/protocol";
import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
} from "@openharness/services";
import { jsonEqual, normalizeTraceId, withoutTraceId } from "../support.js";
import { RunInterruptedError } from "../../runtime/run-coordinator.js";

function inputItems(input: {
  items?: readonly SessionUserInputItem[];
  content?: string;
}): SessionUserInputItem[] {
  return input.items ? [...input.items] : [{ type: "text", text: input.content ?? "" }];
}

function hasPluginCapability(items: readonly SessionUserInputItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "capability" || (item.type === "skill" && item.source === "plugin"),
  );
}

export interface AdmitPromptInput {
  id?: string;
  delivery?: "queue" | "steer";
  items: SessionUserInputItem[];
  content?: string;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  traceId?: string;
  attachments?: AdmitPromptAttachmentInput[];
}

export interface AdmitPromptResult {
  input: SessionInputRecord;
  run?: SessionRunRecord;
  queue_state?: "running" | "queued";
}

export interface RunAdmissionSessionQueries {
  getSession(sessionId: string): { id: string; cwd: string; status: string } | null | undefined;
}

export interface RunAdmissionConversationTransactions {
  admitPrompt(
    input: {
      id?: string;
      sessionId: string;
      delivery?: "queue" | "steer";
      items: SessionUserInputItem[];
      content?: string;
      attachments?: AdmitPromptAttachmentInput[];
      metadata?: Record<string, unknown>;
    },
    options?: { attachmentLimits?: AttachmentLimits },
  ): SessionInputRecord;
  admitPromptWithRun(
    input: {
      prompt: {
        id?: string;
        sessionId: string;
        delivery?: "queue" | "steer";
        items: SessionUserInputItem[];
        content?: string;
        attachments?: AdmitPromptAttachmentInput[];
        metadata?: Record<string, unknown>;
      };
      run?: { id?: string; metadata?: Record<string, unknown> };
    },
    options?: { attachmentLimits?: AttachmentLimits },
  ): { input: SessionInputRecord; run: SessionRunRecord };
  replaceTranscriptAndAdmitPrompt(input: {
    transcript: { sessionId: string; messages: ReplaceTranscriptMessageInput[] };
    admission: {
      prompt: {
        id?: string;
        sessionId: string;
        delivery?: "queue" | "steer";
        items: SessionUserInputItem[];
        attachments?: AdmitPromptAttachmentInput[];
        metadata?: Record<string, unknown>;
      };
      run?: { id?: string; metadata?: Record<string, unknown> };
    };
    createRun?: boolean;
  }): { input: SessionInputRecord; run?: SessionRunRecord; transcript: unknown };
  replaceLatestPromptWithAdmission(input: {
    sessionId: string;
    sourceMessageId: string;
    admission: {
      prompt: {
        id?: string;
        sessionId: string;
        delivery?: "queue" | "steer";
        items: SessionUserInputItem[];
        attachments?: AdmitPromptAttachmentInput[];
        metadata?: Record<string, unknown>;
      };
      run?: { id?: string; metadata?: Record<string, unknown> };
    };
    createRun?: boolean;
  }): { input: SessionInputRecord; run?: SessionRunRecord; transcript: unknown };
  getInput(inputId: string): SessionInputRecord | null | undefined;
}

export interface RunAdmissionRunOperations {
  createRun(input: {
    id?: string;
    sessionId: string;
    inputId?: string;
    metadata?: Record<string, unknown>;
  }): SessionRunRecord;
  getRun(runId: string): SessionRunRecord | null | undefined;
  findRunByInput(inputId: string): SessionRunRecord | null | undefined;
  createReplayRun(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown> },
  ): SessionRunRecord;
  updateRun(runId: string, patch: Partial<SessionRunRecord>): SessionRunRecord;
  appendEvent?(event: {
    type: string;
    sessionId: string;
    payload?: Record<string, unknown>;
  }): void;
  transaction?<T>(work: () => T): T;
}

export interface RunAdmissionRuntimeQueue {
  enqueueRun(run: SessionRunRecord, inputId: string): "running" | "queued";
  runState?(sessionId: string, runId: string): "running" | "queued" | undefined;
  steer(
    sessionId: string,
    input: {
      id: string;
      content: string;
      inputItems: readonly SessionUserInputItem[];
      delivery: "steer";
      traceId?: string;
      metadata?: Record<string, unknown>;
    },
  ):
    | { merged: false }
    | {
        merged: true;
        activeRunId: string;
        delivery: Promise<{ sessionId?: string; inputId?: string; runId: string }>;
      };
  hasRuntime: boolean;
  hasWork?(sessionId: string): boolean;
}

export interface RunAdmissionEvents {
  checkpoint(): number;
  publishSince(checkpoint: number): void;
}

export interface RunAdmissionGoalControl {
  getCurrentGoal?(sessionId: string): { id: string; status: string; revision: number } | undefined;
  cancelGoalRuns?(sessionId: string, goalId: string, reason: string, queuedOnly?: boolean): string[];
}

export interface RunAdmissionMaterializer {
  materializeSteerInput?(
    sessionId: string,
    items: readonly SessionUserInputItem[],
  ): Promise<string>;
}

export interface RunAdmissionServiceOptions {
  sessionQueries?: RunAdmissionSessionQueries;
  conversationTransactions: RunAdmissionConversationTransactions;
  runOperations: RunAdmissionRunOperations;
  runtimeQueue: RunAdmissionRuntimeQueue;
  events: RunAdmissionEvents;
  attachmentLimits?: AttachmentLimits;
  goals?: RunAdmissionGoalControl;
  materializer?: RunAdmissionMaterializer;
  assertReady?: () => void;
}

/**
 * 负责 Prompt 准入、生命周期编排与派发：
 * 将用户输入转化为持久化的 Input / Run 实体，并提交给运行车道队列排队或合并。
 */
export class RunAdmissionService {
  private accepting = true;
  private readonly pendingAdmissions = new Map<
    string,
    {
      sessionId: string;
      delivery: "queue" | "steer";
      items: SessionUserInputItem[];
      attachmentFingerprint: string;
      metadata: Record<string, unknown>;
      promise: Promise<AdmitPromptResult>;
    }
  >();

  constructor(private readonly options: RunAdmissionServiceOptions) {}

  private assertReady(): void {
    this.options.assertReady?.();
  }

  stop(): void {
    this.accepting = false;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  hasPendingAdmission(sessionId: string): boolean {
    return [...this.pendingAdmissions.values()].some(
      (entry) => entry.sessionId === sessionId,
    );
  }

  dispatchPersistedRun(runId: string): "running" | "queued" | undefined {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const run = this.options.runOperations.getRun(runId);
    if (!run?.inputId) throw new Error(`Session run not found: ${runId}`);
    const existingState = this.options.runtimeQueue.runState?.(run.sessionId, runId);
    if (existingState) return existingState;
    if (run.status !== "pending") return undefined;
    return this.options.runtimeQueue.enqueueRun(run, run.inputId);
  }

  recoverRejectedSteer(
    sessionId: string,
    input: { id?: string; traceId?: string },
  ): string {
    if (!input.id) throw new Error("Rejected steer is missing its durable input id");
    const admitted = this.options.conversationTransactions.getInput(input.id);
    if (!admitted || admitted.sessionId !== sessionId) {
      throw new Error(`Rejected steer input was not found: ${input.id}`);
    }
    const existing = this.options.runOperations.findRunByInput(admitted.id);
    if (existing?.inputId === admitted.id) return existing.id;
    const before = this.options.events.checkpoint();
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(admitted.metadata.traceId) ??
      randomUUID();
    const run = this.options.runOperations.createRun({
      sessionId,
      inputId: admitted.id,
      metadata: { traceId, recoveredFromSteer: true },
    });
    this.options.events.publishSince(before);
    this.options.runtimeQueue.enqueueRun(run, admitted.id);
    return run.id;
  }

  persistGoalRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): { input: SessionInputRecord; run: SessionRunRecord } {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    if (!this.options.runtimeQueue.hasRuntime) throw new Error("请先配置模型，再启动目标");
    return this.options.conversationTransactions.admitPromptWithRun(
      {
        prompt: {
          id: input.id,
          sessionId,
          delivery: "queue",
          items: input.items,
          content: input.content,
          attachments: normalizePromptAttachments(input.attachments),
          metadata: input.metadata,
        },
        run: { id: undefined, metadata: input.runMetadata },
      },
      this.options.attachmentLimits ? { attachmentLimits: this.options.attachmentLimits } : undefined,
    );
  }

  replaceTranscriptAndAdmitPrompt(
    sessionId: string,
    messages: ReplaceTranscriptMessageInput[],
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const before = this.options.events.checkpoint();
    const admitted = this.options.conversationTransactions.replaceTranscriptAndAdmitPrompt({
      transcript: { sessionId, messages },
      admission: {
        prompt: {
          id: input.id,
          sessionId,
          delivery: "queue",
          items: inputItems(input),
          attachments: input.attachments,
          metadata,
        },
        run: { metadata: runMetadata },
      },
      createRun: this.options.runtimeQueue.hasRuntime,
    });
    this.options.events.publishSince(before);
    if (!admitted.run) return { input: admitted.input };
    return {
      input: admitted.input,
      run: admitted.run,
      queue_state: this.options.runtimeQueue.enqueueRun(admitted.run, admitted.input.id),
    };
  }

  replaceLatestPrompt(
    sessionId: string,
    sourceMessageId: string,
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const before = this.options.events.checkpoint();
    const admitted = this.options.conversationTransactions.replaceLatestPromptWithAdmission({
      sessionId,
      sourceMessageId,
      admission: {
        prompt: {
          id: input.id,
          sessionId,
          delivery: "queue",
          items: inputItems(input),
          attachments: input.attachments,
          metadata,
        },
        run: { metadata: { ...(input.runMetadata ?? {}), traceId } },
      },
      createRun: this.options.runtimeQueue.hasRuntime,
    });
    this.options.events.publishSince(before);
    if (!admitted.run) return { input: admitted.input };
    return {
      input: admitted.input,
      run: admitted.run,
      queue_state: this.options.runtimeQueue.enqueueRun(admitted.run, admitted.input.id),
    };
  }

  replayInput(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown>; traceId?: string },
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const sourceInput = this.options.conversationTransactions.getInput(inputId);
    if (!sourceInput) throw new Error(`Session input not found: ${inputId}`);
    const existing = input.id ? this.options.runOperations.getRun(input.id) : undefined;
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const before = this.options.events.checkpoint();
    const run = this.options.runOperations.createReplayRun(inputId, {
      id: input.id,
      metadata: { ...(input.metadata ?? {}), traceId },
    });
    this.options.events.publishSince(before);
    if (existing || run.status !== "pending") {
      return {
        input: sourceInput,
        run,
        ...(run.status === "running" ? { queue_state: "running" as const } : {}),
        ...(run.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
    return {
      input: sourceInput,
      run,
      queue_state: this.options.runtimeQueue.enqueueRun(run, sourceInput.id),
    };
  }

  admitPromptAndMaybeRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    this.assertReady();
    if (!this.accepting) {
      return Promise.reject(new Error("Session run engine is stopping"));
    }
    if (input.delivery === "steer" && hasPluginCapability(inputItems(input))) {
      return Promise.reject(new Error("session_capability_requires_queued_run"));
    }
    if (!input.runMetadata?.goalId) {
      const goal = this.options.goals?.getCurrentGoal?.(sessionId);
      if (goal?.status === "active") {
        this.options.goals?.cancelGoalRuns?.(sessionId, goal.id, "用户消息优先", true);
      }
    }
    if (!input.id) return this.admitPrompt(sessionId, input);

    const attachments = normalizePromptAttachments(input.attachments);
    const delivery =
      attachments.length > 0 && input.delivery === "steer"
        ? "queue"
        : (input.delivery ?? "queue");
    const attachmentFingerprint = promptAttachmentFingerprint(attachments);
    const metadata = withoutTraceId(input.metadata ?? {});
    const pending = this.pendingAdmissions.get(input.id);
    if (pending) {
      if (
        pending.sessionId !== sessionId ||
        pending.delivery !== delivery ||
        !jsonEqual(pending.items, inputItems(input)) ||
        pending.attachmentFingerprint !== attachmentFingerprint ||
        !jsonEqual(pending.metadata, metadata)
      ) {
        throw new AttachmentError(
          "prompt_id_conflict",
          `Prompt id is already used: ${input.id}`,
        );
      }
      return pending.promise;
    }
    const promise = this.admitPrompt(sessionId, input).finally(() => {
      if (this.pendingAdmissions.get(input.id!)?.promise === promise) {
        this.pendingAdmissions.delete(input.id!);
      }
    });
    this.pendingAdmissions.set(input.id, {
      sessionId,
      delivery,
      items: inputItems(input),
      attachmentFingerprint,
      metadata,
      promise,
    });
    return promise;
  }

  private async admitPrompt(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    const attachments = normalizePromptAttachments(input.attachments);
    const delivery =
      attachments.length > 0 && input.delivery === "steer"
        ? "queue"
        : (input.delivery ?? "queue");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const existingInput = input.id
      ? this.options.conversationTransactions.getInput(input.id)
      : undefined;

    if (existingInput) {
      if (
        existingInput.sessionId !== sessionId ||
        !jsonEqual(existingInput.items, inputItems(input)) ||
        existingInput.delivery !== delivery ||
        promptAttachmentFingerprint(
          existingInput.attachments.map((reference) => ({
            assetId: reference.assetId,
            intent: reference.intent,
            ...(typeof reference.metadata?.requestedDisplayName === "string"
              ? { displayName: reference.metadata.requestedDisplayName }
              : {}),
          })),
        ) !== promptAttachmentFingerprint(attachments) ||
        !jsonEqual(
          withoutTraceId(existingInput.metadata),
          withoutTraceId(metadata),
        )
      ) {
        throw new AttachmentError(
          "prompt_id_conflict",
          `Prompt id is already used: ${input.id}`,
        );
      }
      const existingRun = this.options.runOperations.findRunByInput(existingInput.id);
      if (!existingRun && this.options.runtimeQueue.hasRuntime) {
        const before = this.options.events.checkpoint();
        const recovered = this.options.runOperations.createRun({
          sessionId,
          inputId: existingInput.id,
          metadata: { ...runMetadata, recoveredAdmission: true },
        });
        this.options.events.publishSince(before);
        return {
          input: existingInput,
          run: recovered,
          queue_state: this.options.runtimeQueue.enqueueRun(recovered, existingInput.id),
        };
      }
      return {
        input: existingInput,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
        ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }

    const before = this.options.events.checkpoint();
    if (delivery === "queue" && this.options.runtimeQueue.hasRuntime) {
      const admission = {
        prompt: {
          id: input.id,
          sessionId,
          delivery,
          items: inputItems(input),
          content: input.content,
          attachments,
          metadata,
        },
        run: { metadata: runMetadata },
      };
      const admitted = this.options.attachmentLimits
        ? this.options.conversationTransactions.admitPromptWithRun(admission, {
            attachmentLimits: this.options.attachmentLimits,
          })
        : this.options.conversationTransactions.admitPromptWithRun(admission);
      this.options.events.publishSince(before);
      return {
        input: admitted.input,
        run: admitted.run,
        queue_state: this.options.runtimeQueue.enqueueRun(admitted.run, admitted.input.id),
      };
    }

    const admission = {
      id: input.id,
      sessionId,
      delivery,
      items: inputItems(input),
      content: input.content,
      attachments,
      metadata,
    };
    const admitted = this.options.attachmentLimits
      ? this.options.conversationTransactions.admitPrompt(admission, {
          attachmentLimits: this.options.attachmentLimits,
        })
      : this.options.conversationTransactions.admitPrompt(admission);

    if (delivery === "steer" && this.options.runtimeQueue.hasRuntime) {
      const items = inputItems(input);
      const steerContent = items.some((item) => item.type === "skill")
        ? await this.materializeSteerInput(sessionId, items)
        : admitted.content;
      const steered = this.options.runtimeQueue.steer(sessionId, {
        id: admitted.id,
        content: steerContent,
        inputItems: admitted.items,
        delivery: "steer",
        traceId,
        metadata: admitted.metadata,
      });
      if (steered.merged && steered.activeRunId) {
        this.options.events.publishSince(before);
        let delivered: Awaited<typeof steered.delivery>;
        try {
          delivered = await steered.delivery;
        } catch (error) {
          this.terminalizeUndeliveredSteer(sessionId, admitted.id, traceId, error);
          throw error;
        }
        const activeRun = this.options.runOperations.getRun(delivered.runId);
        if (!activeRun || activeRun.sessionId !== sessionId) {
          throw new Error(`Steered input run was not found: ${delivered.runId}`);
        }
        return {
          input: admitted,
          run: activeRun,
          ...(activeRun.status === "running" ? { queue_state: "running" as const } : {}),
          ...(activeRun.status === "pending" ? { queue_state: "queued" as const } : {}),
        };
      }
    }

    const run = this.options.runtimeQueue.hasRuntime
      ? this.options.runOperations.createRun({
          sessionId,
          inputId: admitted.id,
          metadata: runMetadata,
        })
      : undefined;
    this.options.events.publishSince(before);
    let queueState: "running" | "queued" | undefined;
    if (run) {
      queueState = this.options.runtimeQueue.enqueueRun(run, admitted.id);
    }
    return {
      input: admitted,
      ...(run ? { run, queue_state: queueState } : {}),
    };
  }

  private async materializeSteerInput(
    sessionId: string,
    items: readonly SessionUserInputItem[],
  ): Promise<string> {
    if (!items.some((item) => item.type === "skill")) return sessionUserInputText(items);
    if (!this.options.materializer?.materializeSteerInput) {
      throw new Error("session_input_skill_catalog_unavailable");
    }
    return await this.options.materializer.materializeSteerInput(sessionId, items);
  }

  private terminalizeUndeliveredSteer(
    sessionId: string,
    inputId: string,
    traceId: string,
    error: unknown,
  ): void {
    if (this.options.runOperations.findRunByInput(inputId)) return;
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = error instanceof RunInterruptedError;
    const before = this.options.events.checkpoint();

    const doTerminalize = () => {
      const created = this.options.runOperations.createRun({
        sessionId,
        inputId,
        metadata: { traceId, steerDeliveryFailed: true },
      });
      this.options.runOperations.appendEvent?.({
        type: interrupted ? "session.run.interrupted" : "session.run.error",
        sessionId,
        payload: {
          runId: created.id,
          traceId,
          error: message,
          steerDeliveryFailure: true,
        },
      });
      this.options.runOperations.updateRun(created.id, {
        status: interrupted ? "interrupted" : "failed",
        error: message,
      });
    };

    if (this.options.runOperations.transaction) {
      this.options.runOperations.transaction(doTerminalize);
    } else {
      doTerminalize();
    }
    this.options.events.publishSince(before);
  }
}
