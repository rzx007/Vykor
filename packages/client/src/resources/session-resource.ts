/**
 * SessionResource: 会话生命周期、快照、消息树、Prompt 准入排队与 Goal 资源。
 */

import type {
  CreateSessionGoalInput,
  GoalActionInput,
  SessionGoal,
  UpdateSessionGoalInput,
} from "@openharness/protocol";
import { decodeSessionStateSnapshot } from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type {
  AdmitClientPromptInput,
  CancelQueuedClientPromptInput,
  CancelQueuedPromptResponse,
  CompactSessionResponse,
  CreateClientSessionInput,
  EditLatestClientPromptInput,
  ForkClientSessionInput,
  InterruptSessionResponse,
  ListClientMessagePartsOptions,
  ListMessagesOptions,
  ListSessionsOptions,
  PromoteQueuedClientPromptInput,
  PromoteQueuedPromptResponse,
  PromptResponse,
  RememberSessionResponse,
  ResumeInterruptedRunInput,
  ResumeInterruptedRunResponse,
  RewindSessionResponse,
  SessionExportResponse,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
  SessionUsageResponse,
  UpdateClientSessionInput,
} from "../types/index.js";

let promptRequestCounter = 0;

/** Generate a caller-stable id for one prompt admission attempt. */
export function createPromptRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  promptRequestCounter += 1;
  return `prompt-${Date.now().toString(36)}-${promptRequestCounter.toString(36)}`;
}

export class SessionResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /sessions` */
  async list(
    options: ListSessionsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ sessions: SessionRecord[] }>(
      this.transport.path("/sessions", query),
      { signal },
    );
    return response.sessions;
  }

  /** `GET /sessions/:id` */
  async get(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `POST /sessions` */
  async create(
    input: CreateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(
      "/sessions",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `PATCH /sessions/:id` - update title, agent, or metadata.runtime fields. */
  async update(
    sessionId: string,
    input: UpdateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `POST /sessions/:id/fork` */
  async fork(
    sessionId: string,
    input: ForkClientSessionInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `DELETE /sessions/:id` */
  async archive(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `DELETE /sessions/:id/hard` */
  async delete(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const response = await this.transport.request<{ deletedSessionIds: string[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/hard`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
    return response.deletedSessionIds;
  }

  /** `GET /sessions/:id/state` - atomic attach snapshot plus SSE cursor. */
  async getState(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionStateSnapshot> {
    const response = await this.transport.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}/state`,
      {
        signal: options.signal,
      },
    );
    return decodeSessionStateSnapshot(response);
  }

  /** `GET /sessions/:id/messages` */
  async listMessages(
    sessionId: string,
    options: ListMessagesOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessageRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ messages: SessionMessageRecord[] }>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/messages`, query),
      { signal },
    );
    return response.messages;
  }

  /** `GET /sessions/:id/parts` */
  async listMessageParts(
    sessionId: string,
    options: ListClientMessagePartsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessagePartRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ parts: SessionMessagePartRecord[] }>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/parts`, query),
      { signal },
    );
    return response.parts;
  }

  /** `POST /sessions/:id/prompts` — 提交用户输入并触发/排队一次 run。 */
  async admitPrompt(
    sessionId: string,
    input: AdmitClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return await this.transport.request<PromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts`,
      {
        method: "POST",
        body: { ...input, id: input.id ?? createPromptRequestId() },
        signal: options.signal,
      },
    );
  }

  /** `POST /sessions/:id/prompts/latest/edit` */
  async editLatestPrompt(
    sessionId: string,
    input: EditLatestClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return await this.transport.request<PromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/latest/edit`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** Promote one durable queued prompt into the exact active run. */
  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: PromoteQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromoteQueuedPromptResponse> {
    return await this.transport.request<PromoteQueuedPromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(inputId)}/promote`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** Cancel one durable prompt that is still waiting in the run queue. */
  async cancelQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: CancelQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CancelQueuedPromptResponse> {
    return await this.transport.request<CancelQueuedPromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(inputId)}/cancel`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /**
   * `POST /sessions/:id/runs/:runId/resume` — 显式重放一次中断 run 的原始 prompt。
   * 不会继续旧 provider stream；服务端会创建一个带恢复溯源的新 input/run。
   */
  async resumeInterruptedRun(
    sessionId: string,
    runId: string,
    input: ResumeInterruptedRunInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ResumeInterruptedRunResponse> {
    return await this.transport.request<ResumeInterruptedRunResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/resume`,
      {
        method: "POST",
        body: { ...input, id: input.id ?? createPromptRequestId() },
        signal: options.signal,
      },
    );
  }

  /** `POST /sessions/:id/interrupt` — 中断当前/排队中的 run。 */
  async interrupt(
    sessionId: string,
    options: { signal?: AbortSignal; expectedRunId?: string } = {},
  ): Promise<InterruptSessionResponse> {
    return await this.transport.request<InterruptSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: "POST",
        body: options.expectedRunId
          ? { expectedRunId: options.expectedRunId }
          : undefined,
        signal: options.signal,
      },
    );
  }

  /** `POST /sessions/:id/compact` */
  async compact(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CompactSessionResponse> {
    return await this.transport.request<CompactSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/compact`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /sessions/:id/rewind` */
  async rewind(
    sessionId: string,
    input: { count?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RewindSessionResponse> {
    return await this.transport.request<RewindSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/rewind`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /sessions/:id/remember` */
  async remember(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RememberSessionResponse> {
    return await this.transport.request<RememberSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/remember`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /sessions/:id/export` */
  async export(
    sessionId: string,
    input: { filename?: string; json?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionExportResponse> {
    return await this.transport.request<SessionExportResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/export`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `GET /sessions/:id/usage` */
  async getUsage(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionUsageResponse> {
    return await this.transport.request<SessionUsageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/usage`,
      { signal: options.signal },
    );
  }

  /** `GET /sessions/:id/goal` */
  async getGoal(sessionId: string): Promise<SessionGoal | null> {
    const response = await this.transport.request<{ goal: SessionGoal | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/goal`,
    );
    return response.goal;
  }

  /** `POST /sessions/:id/goals` */
  async createGoal(
    sessionId: string,
    input: CreateSessionGoalInput,
  ): Promise<SessionGoal> {
    const response = await this.transport.request<{ goal: SessionGoal }>(
      `/sessions/${encodeURIComponent(sessionId)}/goals`,
      { method: "POST", body: input },
    );
    return response.goal;
  }

  /** `PATCH /sessions/:id/goals/:goalId` */
  async updateGoal(
    sessionId: string,
    goalId: string,
    input: UpdateSessionGoalInput,
  ): Promise<SessionGoal> {
    const response = await this.transport.request<{ goal: SessionGoal }>(
      `/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}`,
      { method: "PATCH", body: input },
    );
    return response.goal;
  }

  /** `POST /sessions/:id/goals/:goalId/actions` */
  async applyGoalAction(
    sessionId: string,
    goalId: string,
    input: GoalActionInput,
  ): Promise<SessionGoal> {
    const response = await this.transport.request<{ goal: SessionGoal }>(
      `/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}/actions`,
      { method: "POST", body: input },
    );
    return response.goal;
  }
}
