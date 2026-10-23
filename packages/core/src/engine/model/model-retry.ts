import type { ModelFailureInfo } from "@vykor/agent-contracts";

export interface ModelRetryPolicy {
  requestMaxRetries: number;
  streamMaxRetries: number;
  maxTotalRetries: number;
  recoveryBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/**
 * 本项目首版默认值。首次请求不计入重试次数，因此最多 6 次实际请求
 * （requestMaxRetries + streamMaxRetries 的上界被 maxTotalRetries=5 收敛）。
 */
export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
  requestMaxRetries: 3,
  streamMaxRetries: 3,
  maxTotalRetries: 5,
  recoveryBudgetMs: 180_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  requestTimeoutMs: 60_000,
  streamIdleTimeoutMs: 300_000,
};

/** 已经发起的重试次数，按请求阶段、流阶段和总数分别计数。 */
export interface RetryCounters {
  request: number;
  stream: number;
  total: number;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const NON_NEGATIVE_KEYS = [
  "requestMaxRetries",
  "streamMaxRetries",
  "maxTotalRetries",
  "baseDelayMs",
  "maxDelayMs",
] as const;

const POSITIVE_KEYS = [
  "recoveryBudgetMs",
  "requestTimeoutMs",
  "streamIdleTimeoutMs",
] as const;

/**
 * 校验宿主传入的部分策略：非法或缺失的字段回退到默认值。
 * `maxTotalRetries: 0` 是合法值，用于显式关闭自动重试。
 */
export function normalizeModelRetryPolicy(
  input?: Partial<ModelRetryPolicy>,
): ModelRetryPolicy {
  const out: ModelRetryPolicy = { ...DEFAULT_MODEL_RETRY_POLICY };
  if (!input) return out;
  for (const key of NON_NEGATIVE_KEYS) {
    const value = input[key];
    if (isNonNegativeInt(value)) out[key] = value;
  }
  for (const key of POSITIVE_KEYS) {
    const value = input[key];
    if (isPositiveInt(value)) out[key] = value;
  }
  return out;
}

export interface NextModelRetryDelayInput {
  failure: ModelFailureInfo;
  counters: RetryCounters;
  policy: ModelRetryPolicy;
  now: number;
  /** 恢复窗口的绝对截止时间；首次可重试故障出现时由调用方设定。 */
  deadlineAt: number;
  /** [0, 1)，由调用方传入 Math.random()，便于测试注入。 */
  random: number;
}

/**
 * 计算下一次重试前应等待的毫秒数，或 `undefined` 表示不再重试。
 *
 * - 不可重试错误、分类次数或总次数用完、恢复窗口已过都返回 `undefined`。
 * - 服务端 `Retry-After` 与指数退避取较大值；若服务端要求的等待超过剩余
 *   恢复窗口，直接返回 `undefined`（预算耗尽），不能压短后提前重试。
 */
export function nextModelRetryDelay(
  input: NextModelRetryDelayInput,
): number | undefined {
  const { failure, counters, policy, now, deadlineAt, random } = input;
  if (!failure.retryable) return undefined;
  if (counters.total >= policy.maxTotalRetries) return undefined;
  if (failure.phase === "request" && counters.request >= policy.requestMaxRetries) {
    return undefined;
  }
  if (failure.phase === "stream" && counters.stream >= policy.streamMaxRetries) {
    return undefined;
  }

  const remaining = deadlineAt - now;
  if (remaining <= 0) return undefined;

  const jitter = (Number.isFinite(random) ? Math.max(0, Math.min(random, 1)) : 0) * 250;
  let delay = Math.min(
    policy.baseDelayMs * 2 ** counters.total + jitter,
    policy.maxDelayMs,
  );

  const retryAfterMs = failure.retryAfterMs;
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    if (retryAfterMs > remaining) return undefined;
    delay = Math.max(delay, retryAfterMs);
  }

  if (delay > remaining) return undefined;
  return delay;
}

/**
 * 可取消的等待。预先已取消的信号直接拒绝且不创建定时器；等待结束（成功或
 * 失败）后移除 abort 监听器。
 */
export function waitForModelRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
