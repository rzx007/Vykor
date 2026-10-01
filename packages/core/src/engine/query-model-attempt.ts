import type { ModelAttemptFinishedEvent, UsageSnapshot } from "../index";
import { ModelRequestFailure } from "./model-retry";

/** Combine caller cancellation with the recovery deadline for one request. */
export function createAttemptSignal(external?: AbortSignal, deadlineAt?: number): {
  signal: AbortSignal;
  deadlineExceeded: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let deadlineExceeded = false;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineAt !== undefined && !controller.signal.aborted) {
    const remaining = deadlineAt - Date.now();
    const abortForBudget = () => {
      deadlineExceeded = true;
      controller.abort(
        new ModelRequestFailure(
          "模型恢复时间预算已耗尽",
          { kind: "timeout", phase: "stream", retryable: false },
        ),
      );
    };
    if (remaining <= 0) abortForBudget();
    else timer = setTimeout(abortForBudget, remaining);
  }
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    dispose: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export function describeModelFailure(
  error: unknown,
  external: AbortSignal | undefined,
  attemptSignal: { deadlineExceeded: () => boolean },
): ModelRequestFailure {
  if (error instanceof ModelRequestFailure) return error;
  if (external?.aborted) {
    return new ModelRequestFailure(
      "模型调用已取消",
      { kind: "unknown", phase: "stream", retryable: false },
      external.reason,
    );
  }
  if (attemptSignal.deadlineExceeded()) {
    return new ModelRequestFailure(
      "模型恢复时间预算已耗尽",
      { kind: "timeout", phase: "stream", retryable: false },
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelRequestFailure(
    message,
    { kind: "unknown", phase: "stream", retryable: false },
    error,
  );
}

export function attemptFinishedEvent(
  generationId: string,
  attempt: number,
  status: "completed" | "failed" | "interrupted",
  usage: UsageSnapshot | undefined,
): ModelAttemptFinishedEvent {
  const usageStatus = status === "completed"
    ? (usage ? "complete" : "unknown")
    : (usage ? "partial" : "unknown");
  return {
    type: "model_attempt_finished",
    generationId,
    attempt,
    status,
    usageStatus,
    ...(usage ? { usage } : {}),
  };
}
