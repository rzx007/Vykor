import { DEFAULT_MODEL_RETRY_POLICY, ModelRequestFailure } from "@vykor/core";

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RequestLifecycle {
  /** 传给 SDK/fetch 的信号；外部取消会转发到它。 */
  readonly signal: AbortSignal;
  /** 首个协议事件到达时调用：结束请求超时，改用流空闲超时。 */
  markStreamStarted(): void;
  /** 每收到一个协议事件/心跳时调用，重置流空闲计时。 */
  touch(): void;
  /** 若是内部超时导致中止，返回应抛出的失败；否则 undefined。 */
  timeoutFailure(): ModelRequestFailure | undefined;
  dispose(): void;
}

/**
 * 单次请求的连接与读取超时管理。内部 AbortController 会在请求建立或流空闲
 * 超时时中止底层连接；外部信号取消优先保留其原始原因，不转换成可重试超时。
 */
export function createRequestLifecycle(options: {
  external?: AbortSignal;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}): RequestLifecycle {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MODEL_RETRY_POLICY.requestTimeoutMs;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_RETRY_POLICY.streamIdleTimeoutMs;
  const controller = new AbortController();
  const external = options.external;
  let timedOutPhase: "request" | "stream" | undefined;

  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener("abort", abortFromExternal, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (phase: "request" | "stream", ms: number) => {
    clearTimer();
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      timedOutPhase = phase;
      controller.abort(
        new ModelRequestFailure(
          phase === "request"
            ? `模型请求在 ${ms} 毫秒内未建立连接`
            : `模型流在 ${ms} 毫秒内没有收到数据`,
          { kind: "timeout", phase, retryable: true },
        ),
      );
    }, ms);
  };

  arm("request", requestTimeoutMs);

  return {
    signal: controller.signal,
    markStreamStarted(): void {
      arm("stream", streamIdleTimeoutMs);
    },
    touch(): void {
      if (timedOutPhase === undefined && timer) arm("stream", streamIdleTimeoutMs);
    },
    timeoutFailure(): ModelRequestFailure | undefined {
      if (timedOutPhase === undefined) return undefined;
      const reason = controller.signal.reason;
      return reason instanceof ModelRequestFailure ? reason : undefined;
    },
    dispose(): void {
      clearTimer();
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}
