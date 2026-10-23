import { randomUUID } from "node:crypto";
import { assertPromptMetadataAllowed } from "@vykor/domain-contracts/inputs";
import type { PromptAttachment as AdmitPromptAttachmentInput, SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import type { AttachmentLimits } from "@vykor/domain-contracts/attachments";
import type { ReplaceTranscriptMessageInput } from "@vykor/services";
import type { SessionInputRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
} from "@vykor/services";
import { jsonEqual, normalizeTraceId, withoutTraceId } from "../../support.js";
import { admitPromptWork, inputItems } from "./run-admission-work.js";

function hasPluginCapability(items: readonly SessionUserInputItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "capability" || (item.type === "skill" && item.source === "plugin"),
  );
}

export interface AdmitPromptInput {
  pluginAppContexts?: import("../plugins/plugin-app-inputs.js").PluginAppConversationRequest[];
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
  userWorkSettled?(sessionId: string, failed: boolean): Promise<void>;
  checkExecution?(goalId: string, objectiveVersion: number): void;
  getCurrentGoal?(sessionId: string): { id: string; status: string; objectiveVersion: number } | undefined;
  getGoal?(goalId: string): { id: string; status: string; objectiveVersion: number } | undefined;
  startGoalRun?(goalId: string, objectiveVersion: number, runId: string, continuation: boolean): boolean;
  pendingPermissionId?(sessionId: string): string | undefined;
  waitForApproval?(goalId: string, objectiveVersion: number, permissionRequestId: string): void;
  markGoalContinuation?(runId: string, status: "cancelled"): void;
  hasUserWork?(sessionId: string): boolean;
  cancelGoalRuns?(sessionId: string, goalId: string, reason: string, queuedOnly?: boolean): string[];
}

export interface RunAdmissionMaterializer {
  materializeSteerInput?(
    sessionId: string,
    items: readonly SessionUserInputItem[],
  ): Promise<string>;
}

export interface RunAdmissionServiceOptions {
  materializePluginAppContexts?(sessionId: string, value: unknown): Promise<{ items: SessionUserInputItem[]; assertCurrent(): void }>;
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
      pluginAppContexts?: import("../plugins/plugin-app-inputs.js").PluginAppConversationRequest[];
      metadata: Record<string, unknown>;
      promise: Promise<AdmitPromptResult>;
    }
  >();

  constructor(private readonly options: RunAdmissionServiceOptions) {}

  private readonly preparingUserInputs = new Map<string, Set<Promise<boolean>>>();

  /** Snapshot only submissions that preceded this resume, not later user input. */
  captureUserInputPreparation(sessionId: string): Promise<boolean> | undefined {
    const pending = this.preparingUserInputs.get(sessionId);
    return pending && Promise.all([...pending]).then(results => results.every(Boolean));
  }

  /** Cover the outer plugin/context preparation as well as the final admission. */
  async withUserInputPreparation<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const pending = this.preparingUserInputs.get(sessionId) ?? new Set<Promise<boolean>>();
    const result = work();
    const preparation = result.then(() => true, () => false);
    pending.add(preparation);
    this.preparingUserInputs.set(sessionId, pending);
    let failed = false;
    try { return await result; }
    catch (error) { failed = true; throw error; }
    finally {
      pending.delete(preparation);
      if (!pending.size) this.preparingUserInputs.delete(sessionId);
      void this.options.goals?.userWorkSettled?.(sessionId, failed).catch(() => {});
    }
  }

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
    return this.preparingUserInputs.has(sessionId) || [...this.pendingAdmissions.values()].some(
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
    if (typeof run.metadata.goalId === "string" && typeof run.metadata.goalObjectiveVersion === "number")
      this.options.goals?.checkExecution?.(run.metadata.goalId, run.metadata.goalObjectiveVersion);
    return this.options.runtimeQueue.enqueueRun(run, run.inputId);
  }

  isRunQueuedOrRunning(runId: string): boolean {
    const run = this.options.runOperations.getRun(runId);
    return Boolean(run && this.options.runtimeQueue.runState?.(run.sessionId, runId));
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
      metadata: {
        traceId, recoveredFromSteer: true,
        ...(typeof admitted.metadata.pluginId === "string" ? { pluginId: admitted.metadata.pluginId } : {}),
      },
    });
    this.options.events.publishSince(before);
    this.options.runtimeQueue.enqueueRun(run, admitted.id);
    return run.id;
  }

  prepareRunExecution(runId: string): boolean {
    const run = this.options.runOperations.getRun(runId);
    if (!run) throw new Error(`Session run not found: ${runId}`);
    const isUserRun = !run.metadata.goalRunKind || run.metadata.goalRunKind === "user";
    const permissionId = !isUserRun ? this.options.goals?.pendingPermissionId?.(run.sessionId) : undefined;
    if (!isUserRun && (this.options.goals?.hasUserWork?.(run.sessionId) || permissionId)) {
      this.options.runOperations.updateRun(run.id, { status: "interrupted", error: "用户消息优先" });
      this.options.goals?.markGoalContinuation?.(run.id, "cancelled");
      if (permissionId && typeof run.metadata.goalId === "string" && typeof run.metadata.goalObjectiveVersion === "number")
        this.options.goals?.waitForApproval?.(run.metadata.goalId, run.metadata.goalObjectiveVersion, permissionId);
      return false;
    }
    const goal = isUserRun
      ? this.options.goals?.getCurrentGoal?.(run.sessionId)
      : typeof run.metadata.goalId === "string"
        ? this.options.goals?.getGoal?.(run.metadata.goalId)
        : undefined;
    if (!isUserRun && !goal) {
      this.options.runOperations.updateRun(run.id, { status: "interrupted", error: "目标已不存在" });
      return false;
    }
    if (!goal || (goal.status !== "active" && isUserRun)) return true;
    const objectiveVersion = isUserRun ? goal.objectiveVersion : run.metadata.goalObjectiveVersion;
    if (typeof objectiveVersion === "number") this.options.goals?.checkExecution?.(goal.id, objectiveVersion);
    if (
      typeof objectiveVersion !== "number" ||
      !this.options.goals?.startGoalRun?.(
        goal.id,
        objectiveVersion,
        run.id,
        run.metadata.goalRunKind === "continuation",
      )
    ) {
      this.options.runOperations.updateRun(run.id, { status: "interrupted", error: "目标已暂停或版本已变化" });
      return false;
    }
    if (isUserRun) {
      this.options.runOperations.updateRun(run.id, {
        metadata: { goalId: goal.id, goalObjectiveVersion: objectiveVersion, goalRunKind: "user" },
      });
    }
    return true;
  }

  persistGoalRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): { input: SessionInputRecord; run: SessionRunRecord } {
    assertPromptMetadataAllowed(input);
    if (!this.accepting) throw new Error("Session run engine is stopping");
    if (!this.options.runtimeQueue.hasRuntime) throw new Error("请先配置模型，再启动目标");
    if (typeof input.runMetadata?.goalId === "string" && typeof input.runMetadata.goalObjectiveVersion === "number")
      this.options.goals?.checkExecution?.(input.runMetadata.goalId, input.runMetadata.goalObjectiveVersion);
    return this.persistPromptWithRun(sessionId, input);
  }

  /** Save an accepted Goal answer/change while a budget prevents any Run. */
  persistGoalInput(sessionId: string, input: AdmitPromptInput): SessionInputRecord {
    assertPromptMetadataAllowed(input);
    return this.options.conversationTransactions.admitPrompt({
      id: input.id, sessionId, delivery: "queue", items: input.items, content: input.content,
      attachments: normalizePromptAttachments(input.attachments), metadata: input.metadata,
    }, this.options.attachmentLimits ? { attachmentLimits: this.options.attachmentLimits } : undefined);
  }

  /** 同步保存普通排队输入；调用方提交事务后再处理优先级与派发。 */
  persistQueuedPrompt(
    sessionId: string,
    input: AdmitPromptInput,
  ): { input: SessionInputRecord; run: SessionRunRecord } {
    assertPromptMetadataAllowed(input);
    this.assertReady();
    if (!this.accepting) throw new Error("Session run engine is stopping");
    if (input.delivery === "steer") {
      throw new Error("Steered prompts cannot create their owning run during admission");
    }
    if (!this.options.runtimeQueue.hasRuntime) throw new Error("请先配置模型，再发送消息");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    return this.persistPromptWithRun(sessionId, {
      ...input,
      items: inputItems(input),
      metadata: { ...(input.metadata ?? {}), traceId },
      runMetadata: { ...(input.runMetadata ?? {}), traceId },
    });
  }

  prioritizeUserInput(sessionId: string): void {
    const goal = this.options.goals?.getCurrentGoal?.(sessionId);
    if (goal?.status === "active") {
      this.options.goals?.cancelGoalRuns?.(sessionId, goal.id, "用户消息优先", true);
    }
  }

  private persistPromptWithRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): { input: SessionInputRecord; run: SessionRunRecord } {
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
    assertPromptMetadataAllowed(input);
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
    assertPromptMetadataAllowed(input);
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
    assertPromptMetadataAllowed(input);
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
    assertPromptMetadataAllowed(input);
    this.assertReady();
    if (!this.accepting) {
      return Promise.reject(new Error("Session run engine is stopping"));
    }
    if (input.delivery === "steer" && hasPluginCapability(inputItems(input))) {
      return Promise.reject(new Error("session_capability_requires_queued_run"));
    }
    if (!input.runMetadata?.goalId) {
      this.prioritizeUserInput(sessionId);
    }
    if (!input.id) return admitPromptWork(this.options, sessionId, input);

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
        !jsonEqual(pending.pluginAppContexts, input.pluginAppContexts) ||
        !jsonEqual(pending.metadata, metadata)
      ) {
        throw new AttachmentError(
          "prompt_id_conflict",
          `Prompt id is already used: ${input.id}`,
        );
      }
      return pending.promise;
    }
    let failed = false;
    const promise = admitPromptWork(this.options, sessionId, input).catch(error => {
      failed = true;
      throw error;
    }).finally(() => {
      if (this.pendingAdmissions.get(input.id!)?.promise === promise) {
        this.pendingAdmissions.delete(input.id!);
        if (!input.runMetadata?.goalId)
          void this.options.goals?.userWorkSettled?.(sessionId, failed).catch(() => {});
      }
    });
    this.pendingAdmissions.set(input.id, {
      sessionId,
      delivery,
      items: inputItems(input),
      attachmentFingerprint,
      pluginAppContexts: input.pluginAppContexts,
      metadata,
      promise,
    });
    return promise;
  }
}
