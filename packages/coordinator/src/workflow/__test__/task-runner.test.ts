import { describe, expect, it, vi } from "vitest";
import { runWorkflowTask } from "../task-runner.js";

describe("runWorkflowTask retry eligibility", () => {
  describe.each([
    { reason: "an explicitly non-retryable result", metadata: { retryable: false } },
    { reason: "a result with unconfirmed cleanup", metadata: { cleanupUnconfirmed: true } },
  ])("$reason", ({ metadata }) => {
    it.each([false, true])("does not create another attempt afterDeadline=%s", async afterDeadline => {
      vi.useFakeTimers();
      let releaseResult!: () => void;
      const resultGate = new Promise<void>(resolve => { releaseResult = resolve; });
      const attempts: number[] = [];
      let firstSignal: AbortSignal | undefined;

      try {
        const work = runWorkflowTask(
          { id: "query", retry: { maxAttempts: 2 } },
          async ({ attempt, signal }) => {
            attempts.push(attempt);
            if (attempt > 1) return { summary: "replacement attempt completed" };
            firstSignal = signal;
            await resultGate;
            return { status: "failed", summary: "original query failed", result: "partial work", metadata };
          },
          {}, undefined, undefined, 100, "normal", undefined, () => {},
        );

        await vi.advanceTimersByTimeAsync(afterDeadline ? 100 : 0);
        expect(firstSignal?.aborted).toBe(afterDeadline);
        releaseResult();
        const result = await work;

        expect(attempts).toEqual([1]);
        expect(result).toMatchObject({
          status: "failed",
          attempts: 1,
          result: "partial work",
          metadata,
        });
        expect(result.timedOut).toBe(afterDeadline ? true : undefined);
      } finally {
        releaseResult();
        vi.useRealTimers();
      }
    });
  });

  it.each([false, true])("still retries an eligible failure afterDeadline=%s", async afterDeadline => {
    vi.useFakeTimers();
    const attempts: number[] = [];

    try {
      const work = runWorkflowTask(
        { id: "retryable", retry: { maxAttempts: 2 } },
        async ({ attempt, signal }) => {
          attempts.push(attempt);
          if (attempt === 1) {
            if (afterDeadline) {
              await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
            }
            return { status: "failed", summary: "temporary failure", metadata: { retryable: true } };
          }
          return { summary: "recovered" };
        },
        {}, undefined, undefined, 100, "normal", undefined, () => {},
      );

      await vi.advanceTimersByTimeAsync(afterDeadline ? 100 : 0);
      const result = await work;

      expect(attempts).toEqual([1, 2]);
      expect(result).toMatchObject({ status: "completed", summary: "recovered", attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
