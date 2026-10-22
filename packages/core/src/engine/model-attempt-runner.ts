import type {
  AgentExecutionContext,
  AssistantMessagePhase,
  ToolGenerationProgressEvent,
  ModelAttemptStarted,
  StreamEvent,
  StreamMessageParams,
  StreamingMessageClient,
  ToolUseBlock,
  UsageSnapshot,
} from "@vykor/agent-contracts";
import {
  ModelRequestFailure,
  isAgentExecutionLimitError,
} from "@vykor/agent-contracts";
import type { ModelRetryPolicy } from "./model-retry";
import {
  attemptFinishedEvent,
  createAttemptSignal,
  describeModelFailure,
} from "./query-model-attempt";

export interface ModelAttemptOptions {
  client: StreamingMessageClient;
  request: StreamMessageParams;
  generationId: string;
  attempt: number;
  purpose: ModelAttemptStarted["purpose"];
  provider?: string;
  policy: ModelRetryPolicy;
  signal?: AbortSignal;
  recoveryDeadlineAt?: number;
  execution?: AgentExecutionContext;
  settleUsage(usage: UsageSnapshot | undefined, incomplete: boolean): void;
}

export interface ModelAttemptResult {
  text: string;
  reasoning: string;
  reasoningReplay: string;
  reasoningSegments: Array<{
    source: "reasoning_content" | "think";
    text: string;
  }>;
  phase?: AssistantMessagePhase;
  toolUses: ToolUseBlock[];
  stopReason: string;
  usage?: UsageSnapshot;
  failure?: ModelRequestFailure;
  clientInvoked: boolean;
  progress: import("@vykor/agent-contracts").ToolGenerationProgressEvent[];
}

/** One provider attempt. The caller owns retries, tool execution and mutable history. */
export async function* runModelAttempt(
  options: ModelAttemptOptions,
): AsyncGenerator<StreamEvent, ModelAttemptResult> {
  const { generationId, attempt } = options;
  let assistantText = "";
  let assistantReasoning = "";
  let assistantReasoningReplay = "";
  const assistantReasoningSegments: ModelAttemptResult["reasoningSegments"] =
    [];
  let assistantPhase: AssistantMessagePhase | undefined;
  let stopReason = "end_turn";
  const attemptSignal = createAttemptSignal(
    options.signal,
    options.recoveryDeadlineAt,
  );
  const attemptToolUses: ToolUseBlock[] = [];
  let attemptUsage: UsageSnapshot | undefined;
  let completionSeen = false;
  let attemptFailed: ModelRequestFailure | undefined;
  const pendingProgress = new Map<string, ToolGenerationProgressEvent>();
  const progressSentAt = new Map<string, number>();
  let registered = false;
  let clientInvoked = false;
  let requestExitedNormally = false;

  try {
    await options.execution?.limits?.check("model");
    await options.execution?.emit({
      type: "model.attempt.started",
      data: {
        generationId,
        attempt,
        model: options.request.model,
        ...(options.provider ? { provider: options.provider } : {}),
        purpose: options.purpose,
      },
    });
    registered = true;
    attemptSignal.signal.throwIfAborted();
    clientInvoked = true;
    const stream = options.client.streamMessage({
      ...options.request,
      abortSignal: attemptSignal.signal,
      requestTimeoutMs: options.policy.requestTimeoutMs,
      streamIdleTimeoutMs: options.policy.streamIdleTimeoutMs,
    });

    for await (const event of stream) {
      if (event.type === "text_delta") {
        assistantText += event.delta;
        assistantPhase = event.phase ?? assistantPhase;
        yield event;
      } else if (event.type === "reasoning_delta") {
        assistantReasoning += event.delta;
        const lastSegment = assistantReasoningSegments.at(-1);
        if (lastSegment?.source === event.source)
          lastSegment.text += event.delta;
        else
          assistantReasoningSegments.push({
            source: event.source,
            text: event.delta,
          });
        if (event.source === "reasoning_content") {
          assistantReasoningReplay += event.delta;
        }
        yield event;
      } else if (event.type === "tool_generation_progress") {
        const progress = { ...event, generationId, attempt };
        const now = Date.now();
        const lastSent = progressSentAt.get(event.toolKey);
        if (event.discarded === true || event.filePath === null) {
          pendingProgress.delete(event.toolKey);
          progressSentAt.delete(event.toolKey);
          yield progress;
        } else if (lastSent === undefined || now - lastSent >= 250) {
          progressSentAt.set(event.toolKey, now);
          pendingProgress.delete(event.toolKey);
          yield progress;
        } else {
          pendingProgress.set(event.toolKey, progress);
        }
      } else if (event.type === "tool_use_start") {
        attemptToolUses.push(event.toolUse);
      } else if (event.type === "usage") {
        attemptUsage = event.usage;
      } else if (event.type === "complete") {
        stopReason = event.stopReason;
        completionSeen = true;
      } else if (event.type === "error") {
        throw event.error;
      } else {
        yield event;
      }
    }

    if (!completionSeen) {
      throw new ModelRequestFailure("模型流在完成前结束（缺少完成标记）", {
        kind: "stream_incomplete",
        phase: "stream",
        retryable: true,
      });
    }
    requestExitedNormally = true;
  } catch (error) {
    requestExitedNormally = true;
    if (!registered) throw error;
    if (isAgentExecutionLimitError(error)) {
      options.settleUsage(attemptUsage, clientInvoked);
      yield attemptFinishedEvent(
        generationId,
        attempt,
        "failed",
        attemptUsage,
        clientInvoked ? undefined : true,
      );
      throw error;
    }
    attemptFailed = describeModelFailure(error, options.signal, attemptSignal);
  } finally {
    attemptSignal.dispose();
    // A consumer can return() while we are suspended at a streamed delta.
    // It will ignore a finally yield, so settle directly through the host.
    if (registered && !requestExitedNormally) {
      options.settleUsage(attemptUsage, clientInvoked);
      const { type: _, ...data } = attemptFinishedEvent(
        generationId,
        attempt,
        options.signal?.aborted ? "interrupted" : "failed",
        attemptUsage,
        clientInvoked ? undefined : true,
      );
      await options.execution?.emit({
        type: "model.attempt.finished",
        data,
      });
      if (attemptUsage)
        await options.execution?.emit({
          type: "usage.updated",
          data: { usage: attemptUsage },
        });
    }
  }

  return {
    text: assistantText,
    reasoning: assistantReasoning,
    reasoningReplay: assistantReasoningReplay,
    reasoningSegments: assistantReasoningSegments,
    phase: assistantPhase,
    toolUses: attemptToolUses,
    stopReason,
    usage: attemptUsage,
    failure: attemptFailed,
    clientInvoked,
    progress: [...pendingProgress.values()],
  };
}
