import { randomUUID } from "node:crypto";

import type { StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import type { ModelAttemptFinishedEvent } from "@vykor/agent-contracts";
import type { StreamEvent } from "@vykor/agent-contracts";
import type { UsageSnapshot } from "@vykor/agent-contracts";
import { isAgentExecutionLimitError, type AgentExecutionLimits } from "@vykor/agent-contracts";
import type { ModelAttemptStarted } from "@vykor/agent-contracts";
import type { AgentRunScope, ModelAttemptGate } from "@vykor/agent-contracts";
import { ModelRequestFailure } from "@vykor/agent-contracts";
import {
  nextModelRetryDelay,
  normalizeModelRetryPolicy,
  waitForModelRetry,
  type ModelRetryPolicy,
  type RetryCounters,
} from "./model-retry";
import { attemptFinishedEvent, createAttemptSignal, describeModelFailure } from "./query-model-attempt";
import { modelAttemptControl } from "./model-attempt-control";

export interface BufferedModelRetryOptions {
  onAttemptStarted?: (event: ModelAttemptStarted) => void | Promise<void>;
  limits?: AgentExecutionLimits;
  scope?: AgentRunScope;
  modelAttempts?: ModelAttemptGate;
  provider?: string;
  purpose?: ModelAttemptStarted["purpose"];
  policy?: Partial<ModelRetryPolicy>;
  /** 每次实际请求结算一次用量；不产生 Run 时由宿主记录，不伪造 Run。 */
  onAttemptFinished?: (event: ModelAttemptFinishedEvent) => void | Promise<void>;
  /** 测试可注入稳定的 generationId。 */
  generationId?: string;
}

/**
 * 压缩摘要与记忆提取等「辅助模型调用」的有界重试包装。
 *
 * 与主生成不同，辅助调用先缓冲整段输出，只有确认收到完成标记后才把内容交给
 * 调用方；失败尝试的残缺文本永远不会拼进摘要或 JSON。计数、截止时间和
 * generationId 每次辅助调用独立，不共享主生成预算。
 */
export async function* streamBufferedModelWithRetry(
  client: StreamingMessageClient,
  params: StreamMessageParams,
  options: BufferedModelRetryOptions = {},
): AsyncIterable<StreamEvent> {
  if (options.modelAttempts && !options.scope) throw new Error("A model attempt gate requires a host-owned Run scope");
  if (params.tools && params.tools.length > 0) {
    throw new Error("streamBufferedModelWithRetry is only valid for tool-free auxiliary calls");
  }
  const policy = normalizeModelRetryPolicy(options.policy);
  const generationId = options.generationId ?? randomUUID();
  const counters: RetryCounters = { request: 0, stream: 0, total: 0 };
  let recoveryDeadlineAt: number | undefined;
  let attempt = 1;

  while (true) {
    const buffered: StreamEvent[] = [];
    let usage: UsageSnapshot | undefined;
    let completeSeen = false;
    let failure: ModelRequestFailure | undefined;
    const attemptSignal = createAttemptSignal(params.abortSignal, recoveryDeadlineAt);
    let registered = false;
    let admitted = false;
    let gateSettled = false;
    let clientInvoked = false;
    let succeeded = false;
    const settleGate = async (status: "completed" | "failed" | "interrupted") => {
      if (!admitted || gateSettled) return;
      gateSettled = true;
      const { type: _, ...settlement } = attemptFinishedEvent(generationId, attempt, status, usage, clientInvoked ? undefined : true);
      await modelAttemptControl(() => options.modelAttempts!.settle({ scope: options.scope!, ...settlement }));
    };

    try {
      await options.limits?.check("model");
      if (options.modelAttempts) {
        await modelAttemptControl(() => options.modelAttempts!.beforeDispatch({ scope: options.scope!, generationId, attempt, model: params.model,
          ...(options.provider ? { provider: options.provider } : {}), purpose: options.purpose ?? "compaction" }));
        admitted = true;
      }
      await modelAttemptControl(() => options.onAttemptStarted?.({ generationId, attempt, model: params.model,
        ...(options.provider ? { provider: options.provider } : {}), purpose: options.purpose ?? "compaction" }));
      registered = true;
      attemptSignal.signal.throwIfAborted();
      clientInvoked = true;
      const stream = client.streamMessage({
        ...params,
        abortSignal: attemptSignal.signal,
        requestTimeoutMs: policy.requestTimeoutMs,
        streamIdleTimeoutMs: policy.streamIdleTimeoutMs,
      });
      for await (const event of stream) {
        if (event.type === "usage") {
          usage = event.usage;
          continue;
        }
        if (event.type === "complete") {
          if (event.stopReason === "max_tokens" || event.stopReason === "length") {
            throw new ModelRequestFailure(
              "辅助模型输出达到长度上限，未返回完整结果",
              { kind: "stream_incomplete", phase: "stream", retryable: false },
            );
          }
          completeSeen = true;
          buffered.push(event);
          continue;
        }
        if (event.type === "error") throw event.error;
        if (
          event.type === "generation_started" ||
          event.type === "model_retry" ||
          event.type === "model_attempt_finished"
        ) {
          continue;
        }
        buffered.push(event);
      }
      if (!completeSeen) {
        throw new ModelRequestFailure(
          "辅助模型流在完成前结束（缺少完成标记）",
          { kind: "stream_incomplete", phase: "stream", retryable: true },
        );
      }
      succeeded = true;
    } catch (error) {
      if (!registered) throw error;
      if (isAgentExecutionLimitError(error)) {
        await settleGate(params.abortSignal?.aborted ? "interrupted" : "failed");
        await modelAttemptControl(() => options.onAttemptFinished?.(attemptFinishedEvent(generationId, attempt, "failed", usage,
          clientInvoked ? undefined : true)));
        throw error;
      }
      failure = describeModelFailure(error, params.abortSignal, attemptSignal);
    } finally {
      attemptSignal.dispose();
      await settleGate(params.abortSignal?.aborted ? "interrupted" : succeeded ? "completed" : "failed");
    }

    if (failure) {
      await modelAttemptControl(() => options.onAttemptFinished?.(attemptFinishedEvent(
        generationId, attempt, params.abortSignal?.aborted ? "interrupted" : "failed", usage, clientInvoked ? undefined : true,
      )));
      if (params.abortSignal?.aborted) throw params.abortSignal.reason;
      if (!failure.info.retryable) throw failure;

      if (recoveryDeadlineAt === undefined) {
        recoveryDeadlineAt = Date.now() + policy.recoveryBudgetMs;
      }
      const now = Date.now();
      const delay = nextModelRetryDelay({
        failure: failure.info,
        counters,
        policy,
        now,
        deadlineAt: recoveryDeadlineAt,
        random: Math.random(),
      });
      if (delay === undefined) throw failure;

      if (failure.info.phase === "request") counters.request++;
      else counters.stream++;
      counters.total++;
      await waitForModelRetry(delay, params.abortSignal);
      attempt++;
      continue;
    }

    await modelAttemptControl(() => options.onAttemptFinished?.(attemptFinishedEvent(generationId, attempt, "completed", usage)));
    for (const event of buffered) yield event;
    return;
  }
}
