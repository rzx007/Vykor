import { describe, expect, it, vi } from "vitest";
import { createRequestLifecycle } from "./retry.js";

describe("createRequestLifecycle", () => {
  it("keeps the provider defaults at 60 seconds to connect and 300 seconds of stream idle", async () => {
    vi.useFakeTimers();
    try {
      const request = createRequestLifecycle({});
      await vi.advanceTimersByTimeAsync(59_999);
      expect(request.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(request.timeoutFailure()?.info.phase).toBe("request");
      request.dispose();

      const stream = createRequestLifecycle({});
      stream.markStreamStarted();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(stream.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.timeoutFailure()?.info.phase).toBe("stream");
      stream.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

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
