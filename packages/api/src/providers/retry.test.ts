import { describe, expect, it, vi } from "vitest";
import { abortableDelay, createRequestLifecycle } from "./retry.js";

describe("abortableDelay", () => {
  it("keeps its timer referenced so a standalone process waits for retry", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) => {
        timer = realSetTimeout(handler, timeout, ...args);
        return timer;
      }) as typeof setTimeout);
    const controller = new AbortController();
    const interrupted = new Error("stop test delay");
    let observedRejection: Promise<unknown> | undefined;

    try {
      const delay = abortableDelay(10_000, controller.signal);
      observedRejection = delay.catch((error) => error);

      expect(timer?.hasRef()).toBe(true);
      controller.abort(interrupted);
      expect(await observedRejection).toBe(interrupted);
    } finally {
      controller.abort(interrupted);
      await observedRejection;
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("createRequestLifecycle", () => {
  it("aborts with a retryable request timeout if no connection is established", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createRequestLifecycle({ requestTimeoutMs: 1_000, streamIdleTimeoutMs: 5_000 });
      expect(lifecycle.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.timeoutFailure()?.info).toMatchObject({
        kind: "timeout",
        phase: "request",
        retryable: true,
      });
      lifecycle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the stream idle timer on each received event", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createRequestLifecycle({ requestTimeoutMs: 1_000, streamIdleTimeoutMs: 2_000 });
      lifecycle.markStreamStarted();
      await vi.advanceTimersByTimeAsync(1_500);
      lifecycle.touch();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(lifecycle.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.timeoutFailure()?.info.phase).toBe("stream");
      lifecycle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the external cancellation reason and reports no timeout", async () => {
    const external = new AbortController();
    const reason = new Error("caller cancelled");
    const lifecycle = createRequestLifecycle({ external: external.signal });
    external.abort(reason);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toBe(reason);
    expect(lifecycle.timeoutFailure()).toBeUndefined();
    lifecycle.dispose();
  });

  it("does not abort after dispose", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createRequestLifecycle({ requestTimeoutMs: 1_000, streamIdleTimeoutMs: 1_000 });
      lifecycle.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(lifecycle.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
