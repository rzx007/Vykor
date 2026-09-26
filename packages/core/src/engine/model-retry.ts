import type { UsageSnapshot } from "../types/usage";

/**
 * 模型调用失败类别。用于决定是否重试以及向后端/界面报告的诊断信息。
 * 这里是纯数据描述，不依赖 API 包，避免 core 反向依赖具体提供商实现。
 */
export type ModelFailureKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "stream_incomplete"
  | "authentication"
  | "invalid_request"
  | "quota"
  | "protocol"
  | "unknown";

/**
 * 一次失败的结构化信息：哪一段连接失败（请求建立还是流读取）、是否能重试、
 * HTTP 状态码、服务端要求的等待时间，以及可获得的请求标识。
 */
export interface ModelFailureInfo {
  kind: ModelFailureKind;
  phase: "request" | "stream";
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  requestId?: string;
}

/**
 * 适配器抛出的统一模型失败类型。原始异常通过 `cause` 保留，只有该结构会进入
 * 重试策略；序列化到客户端时必须换成安全摘要，不能带完整 cause 对象。
 */
export class ModelRequestFailure extends Error {
  constructor(
    message: string,
    readonly info: ModelFailureInfo,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ModelRequestFailure";
  }
}

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

/** 未知尝试计入用量时的完整性快照类型，供引擎与持久层共享。 */
export type ModelAttemptUsageStatus = "complete" | "partial" | "unknown";

export interface ModelAttemptFinishedEvent extends GenerationIdentity {
  type: "model_attempt_finished";
  status: "completed" | "failed" | "interrupted";
  usageStatus: ModelAttemptUsageStatus;
  /** 已知消耗；unknown 时省略，不能用 0 冒充已知。 */
  usage?: UsageSnapshot;
}
