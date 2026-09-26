import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL_RETRY_POLICY,
  type ModelFailureInfo,
  ModelRequestFailure,
  nextModelRetryDelay,
  normalizeModelRetryPolicy,
  waitForModelRetry,
} from "./model-retry";

function failure(overrides: Partial<ModelFailureInfo> = {}): ModelFailureInfo {
  return {
    kind: "network",
    phase: "request",
    retryable: true,
    ...overrides,
  };
}

describe("normalizeModelRetryPolicy", () => {
  it("returns defaults when input is absent", () => {
    expect(normalizeModelRetryPolicy()).toEqual(DEFAULT_MODEL_RETRY_POLICY);
  });

  it("keeps valid overrides including maxTotalRetries: 0", () => {
    const policy = normalizeModelRetryPolicy({ maxTotalRetries: 0, baseDelayMs: 5 });
    expect(policy.maxTotalRetries).toBe(0);
    expect(policy.baseDelayMs).toBe(5);
    expect(policy.requestMaxRetries).toBe(DEFAULT_MODEL_RETRY_POLICY.requestMaxRetries);
  });

  it("falls back to defaults for invalid values", () => {
    const policy = normalizeModelRetryPolicy({
      maxTotalRetries: -1,
      baseDelayMs: 1.5,
      requestTimeoutMs: 0,
      streamIdleTimeoutMs: Number.NaN,
      recoveryBudgetMs: Number.POSITIVE_INFINITY,
      maxDelayMs: -10,
    });
    expect(policy.maxTotalRetries).toBe(DEFAULT_MODEL_RETRY_POLICY.maxTotalRetries);
    expect(policy.baseDelayMs).toBe(DEFAULT_MODEL_RETRY_POLICY.baseDelayMs);
    expect(policy.requestTimeoutMs).toBe(DEFAULT_MODEL_RETRY_POLICY.requestTimeoutMs);
    expect(policy.streamIdleTimeoutMs).toBe(DEFAULT_MODEL_RETRY_POLICY.streamIdleTimeoutMs);
    expect(policy.recoveryBudgetMs).toBe(DEFAULT_MODEL_RETRY_POLICY.recoveryBudgetMs);
    expect(policy.maxDelayMs).toBe(DEFAULT_MODEL_RETRY_POLICY.maxDelayMs);
  });
});

describe("nextModelRetryDelay", () => {
  const policy = DEFAULT_MODEL_RETRY_POLICY;
  const now = 1_000;
  const deadlineAt = now + policy.recoveryBudgetMs;

  it("computes exponential delay using total retries", () => {
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 0, stream: 0, total: 0 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBe(1_000);
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 2, stream: 0, total: 3 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBe(8_000);
  });

  it("does not retry non-retryable failures", () => {
    expect(
      nextModelRetryDelay({
        failure: failure({ retryable: false }),
        counters: { request: 0, stream: 0, total: 0 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBeUndefined();
  });

  it("stops when the total retry budget is exhausted", () => {
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 5, stream: 0, total: 5 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBeUndefined();
  });

  it("counts request and stream failures separately", () => {
    expect(
      nextModelRetryDelay({
        failure: failure({ phase: "request" }),
        counters: { request: 3, stream: 0, total: 3 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBeUndefined();
    expect(
      nextModelRetryDelay({
        failure: failure({ phase: "stream" }),
        counters: { request: 3, stream: 2, total: 5 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBeUndefined();
    expect(
      nextModelRetryDelay({
        failure: failure({ phase: "stream" }),
        counters: { request: 3, stream: 2, total: 2 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBe(4_000);
  });

  it("honors a server Retry-After larger than the backoff", () => {
    expect(
      nextModelRetryDelay({
        failure: failure({ kind: "rate_limit", retryAfterMs: 12_000 }),
        counters: { request: 0, stream: 0, total: 0 },
        policy,
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBe(12_000);
  });

  it("does not shorten the server retry delay to fit the recovery window", () => {
    expect(
      nextModelRetryDelay({
        failure: { kind: "rate_limit", phase: "request", retryable: true, retryAfterMs: 60_000 },
        counters: { request: 0, stream: 0, total: 0 },
        policy: DEFAULT_MODEL_RETRY_POLICY,
        now: 1_000,
        deadlineAt: 31_000,
        random: 0,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the backoff would outlast the recovery window", () => {
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 0, stream: 0, total: 0 },
        policy,
        now: 30_500,
        deadlineAt: 31_000,
        random: 0,
      }),
    ).toBeUndefined();
  });

  it("returns undefined once the deadline has passed", () => {
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 0, stream: 0, total: 0 },
        policy,
        now: 40_000,
        deadlineAt: 31_000,
        random: 0,
      }),
    ).toBeUndefined();
  });

  it("returns undefined immediately when retries are disabled", () => {
    expect(
      nextModelRetryDelay({
        failure: failure(),
        counters: { request: 0, stream: 0, total: 0 },
        policy: normalizeModelRetryPolicy({ maxTotalRetries: 0 }),
        now,
        deadlineAt,
        random: 0,
      }),
    ).toBeUndefined();
  });
});

describe("waitForModelRetry", () => {
  it("rejects a pre-aborted signal without creating a timer", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const reason = new Error("cancelled before wait");
    controller.abort(reason);
    await expect(waitForModelRetry(1_000, controller.signal)).rejects.toBe(reason);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("resolves after the delay and cleans up the abort listener", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const wait = waitForModelRetry(50, controller.signal);
      await vi.advanceTimersByTimeAsync(50);
      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the abort reason while waiting", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("stop waiting");
      const wait = waitForModelRetry(10_000, controller.signal);
      const observed = wait.catch((error) => error);
      controller.abort(reason);
      await expect(observed).resolves.toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ModelRequestFailure", () => {
  it("preserves the original cause and structured info", () => {
    const cause = new Error("socket closed");
    const error = new ModelRequestFailure(
      "connection reset",
      { kind: "network", phase: "stream", retryable: true, statusCode: 503 },
      cause,
    );
    expect(error.name).toBe("ModelRequestFailure");
    expect(error.info).toEqual({
      kind: "network",
      phase: "stream",
      retryable: true,
      statusCode: 503,
    });
    expect(error.cause).toBe(cause);
  });
});
