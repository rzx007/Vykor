import { afterEach, describe, expect, it, vi } from "vitest";

import { DeltaCheckpoint } from "./delta-checkpoint.js";

afterEach(() => vi.useRealTimers());

describe("DeltaCheckpoint", () => {
  it("schedules one flush and retries after a failed flush", async () => {
    vi.useFakeTimers();
    const flush = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("checkpoint failed");
      })
      .mockImplementation(() => undefined);
    const checkpoint = new DeltaCheckpoint({
      intervalMs: 150,
      bytes: 8192,
      flush,
    });

    expect(checkpoint.markDirty("part-1", 100)).toBe(false);
    checkpoint.schedule();
    checkpoint.schedule();
    await vi.advanceTimersByTimeAsync(150);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("reports the byte threshold and restores an isolated snapshot", () => {
    const checkpoint = new DeltaCheckpoint({
      intervalMs: 150,
      bytes: 8,
      flush: () => undefined,
    });
    checkpoint.markDirty("part-1", 3);
    const snapshot = checkpoint.snapshot();
    expect(checkpoint.markDirty("part-2", 5)).toBe(true);

    checkpoint.restore(snapshot);

    expect(checkpoint.dirtyPartIds()).toEqual(["part-1"]);
    expect(checkpoint.pendingBytes).toBe(3);
  });

  it("does not flush after it is closed", async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const checkpoint = new DeltaCheckpoint({
      intervalMs: 10,
      bytes: 100,
      flush,
    });
    checkpoint.markDirty("part-1", 1);
    checkpoint.schedule();
    checkpoint.close();

    await vi.advanceTimersByTimeAsync(20);

    expect(flush).not.toHaveBeenCalled();
  });
});
