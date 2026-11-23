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
import { modelAttemptControl } from "./model-attempt-control";
import { isPromptTooLongError } from "../compaction/compact-summary";
import {
  attemptFinishedEvent,
  createAttemptSignal,
  describeModelFailure,
} from "./query-model-attempt";

export interface ModelAttemptOptions {
  /** Hold candidate answer text while delegated results may still change it. */
  deferText?: boolean;
  client: StreamingMessageClient;
  request: StreamMessageParams;
  prepareRequest?(): StreamMessageParams;
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

function safeImageUsage(usage: UsageSnapshot): UsageSnapshot {
  const tokenCount = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const metering = usage.metering;
  const incomplete = input === undefined || output === undefined || usage.usageIncomplete === true;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheCreationTokens: tokenCount(usage.cacheCreationTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    ...(typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? { costUsd: usage.costUsd } : {}),
    ...(incomplete ? { usageIncomplete: true } : {}),
    ...(metering ? { metering: {
      knownInputTokens: tokenCount(metering.knownInputTokens) ?? 0,
      knownOutputTokens: tokenCount(metering.knownOutputTokens) ?? 0,
      completeness: metering.completeness === "complete" && !incomplete ? "complete"
        : metering.completeness === "unknown" ? "unknown" : "partial",
      inputIncludesCache: metering.inputIncludesCache === true,
      raw: {},
    } } : {}),
  };
}

function safeImageFailure(failure: ModelRequestFailure): ModelRequestFailure {
  // Compatible endpoints can echo the screenshot in their error and request ID.
  const { requestId: _untrusted, ...info } = failure.info;
  return new ModelRequestFailure("附有临时窗口截图的模型请求失败", {
    ...info,
    ...(info.kind === "invalid_request" ? { contextLengthExceeded: isPromptTooLongError(failure) } : {}),
  });
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
  let admitted = false;
  let gateSettled = false;
  let clientInvoked = false;
  let hasPrivateImage = false;
  let requestExitedNormally = false;
  let nextStreamActivityAt = 0;
  const settleGate = async (status: "completed" | "failed" | "interrupted") => {
    if (!admitted || gateSettled) return;
    gateSettled = true;
    const { type: _, ...settlement } = attemptFinishedEvent(
      generationId, attempt, status, attemptUsage, clientInvoked ? undefined : true,
    );
    await modelAttemptControl(() => options.execution!.modelAttempts!.settle({ scope: options.execution!.scope, ...settlement }));
  };

  try {
    await options.execution?.limits?.check("model");
    if (options.execution?.modelAttempts) {
      const { modelAttempts, scope } = options.execution;
      await modelAttemptControl(() => modelAttempts.beforeDispatch({
        scope, generationId, attempt,
        model: options.request.model, provider: options.provider, purpose: options.purpose,
      }));
      admitted = true;
    }
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
    const request = options.prepareRequest?.() ?? options.request;
    hasPrivateImage = request.isEphemeralImageCurrent !== undefined;
    clientInvoked = true;
    const stream = options.client.streamMessage({
      ...request,
      abortSignal: attemptSignal.signal,
      requestTimeoutMs: options.policy.requestTimeoutMs,
      streamIdleTimeoutMs: options.policy.streamIdleTimeoutMs,
      onStreamActivity: () => {
        const now = Date.now();
        if (now < nextStreamActivityAt) return;
        nextStreamActivityAt = now + 15_000;
        // Diagnostic delivery must not delay or fail the model stream.
        try {
          options.execution?.observe?.({ type: "domain.event", data: {
            name: "model.stream.activity", payload: { generationId, attempt },
          } });
        } catch { /* Optional diagnostic event. */ }
      },
    });

    for await (const event of stream) {
      if (event.type === "text_delta") {
        assistantText += event.delta;
        assistantPhase = event.phase ?? assistantPhase;
        if (!options.deferText) yield event;
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
        // Some compatible endpoints echo request fields in arbitrary usage metadata.
        attemptUsage = hasPrivateImage ? safeImageUsage(event.usage) : event.usage;
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
      await settleGate(options.signal?.aborted ? "interrupted" : "failed");
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
    if (hasPrivateImage) attemptFailed = safeImageFailure(attemptFailed);
  } finally {
    attemptSignal.dispose();
    await settleGate(options.signal?.aborted ? "interrupted"
      : registered && requestExitedNormally && !attemptFailed && completionSeen
        && !(options.purpose === "finalization" && attemptToolUses.length > 0) ? "completed" : "failed");
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
