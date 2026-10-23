import type { UsageSnapshot } from "./usage.js";
import type { ModelFailureKind } from "./errors.js";

/**
 * 一次「模型调用」的稳定标识。重试同一次生成时 generationId 保持不变、
 * attempt 递增；新的正常模型回合使用新的 generationId。
 */
export interface GenerationIdentity {
  generationId: string;
  /** 从 1 开始；首次请求为 1。 */
  attempt: number;
}

/**
 * 引擎在等待下一次重试前发布的状态。`nextRetryAt` 与 `recoveryDeadlineAt`
 * 都是绝对毫秒时间戳。
 */
export interface ModelRetryState extends GenerationIdentity {
  /** 下一次重试是第几次，从 1 开始。 */
  retryNumber: number;
  /** 本次生成允许的总重试上限。 */
  maxRetries: number;
  reason: ModelFailureKind;
  nextRetryAt: number;
  recoveryDeadlineAt: number;
}

/** 未知尝试计入用量时的完整性快照类型，供引擎与持久层共享。 */
export type ModelAttemptUsageStatus = "complete" | "partial" | "unknown";

export interface ModelAttemptFinishedEvent extends GenerationIdentity {
  type: "model_attempt_finished";
  status: "completed" | "failed" | "interrupted";
  usageStatus: ModelAttemptUsageStatus;
  /** 已知消耗；unknown 时省略，不能用 0 冒充已知。 */
  usage?: UsageSnapshot;
  /** Host proved the client was never called after registration. */
  notDispatched?: true;
}

export interface ModelAttemptStarted extends GenerationIdentity {
  model: string;
  provider?: string;
  purpose: "generation" | "compaction" | "finalization" | "memory" | "plugin_selection";
}

import type { ContentBlock, Message } from "../conversation/messages.js";
import type { StreamEvent } from "../execution/events.js";
import type { ToolDefinition } from "../tools/tools.js";

export interface StreamMessageParams {
  model: string;
  messages: readonly Message[];
  system?: string;
  tools?: readonly ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
  /** 连接阶段（请求建立）的时间上限，毫秒。 */
  requestTimeoutMs?: number;
  /** 流连续没有收到协议事件/心跳的时间上限，毫秒。 */
  streamIdleTimeoutMs?: number;
}

export interface StreamingMessageClient {
  prepareUserContent?(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]>;
  streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent>;
}
