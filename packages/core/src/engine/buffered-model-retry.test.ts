import { describe, expect, it, vi } from "vitest";

import { streamBufferedModelWithRetry } from "./buffered-model-retry.js";
import { ModelRequestFailure } from "./model-retry.js";
import type { ModelAttemptFinishedEvent, StreamEvent, StreamMessageParams } from "../index.js";

async function collect(
  client: { streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> },
  options?: Parameters<typeof streamBufferedModelWithRetry>[2],
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamBufferedModelWithRetry(
    client as never,
    { model: "m", messages: [{ type: "user", content: "prompt" }] },
    options,
  )) {
    events.push(event);
  }
  return events;
}

describe("streamBufferedModelWithRetry", () => {
  it("delivers only the successful attempt and drops the failed prefix", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            yield { type: "text_delta", delta: '{"memories": [{"body": "半截' };
            throw new ModelRequestFailure("connection reset", {
              kind: "network",
              phase: "stream",
              retryable: true,
            });
          }
          yield { type: "text_delta", delta: '{"memories": []}' };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };

      const run = collect(client);
      await vi.advanceTimersByTimeAsync(5_000);
      const events = await run;

      const text = events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join("");
      expect(text).toBe('{"memories": []}');
      expect(text).not.toContain("半截");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports one attempt-finished event per request", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const finished: ModelAttemptFinishedEvent[] = [];
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            throw new ModelRequestFailure("rate limited", {
              kind: "rate_limit",
              phase: "request",
              retryable: true,
            });
          }
          yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
          yield { type: "text_delta", delta: "ok" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };

      const run = collect(client, { onAttemptFinished: (event) => finished.push(event) });
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(finished.map((event) => [event.attempt, event.status, event.usageStatus])).toEqual([
        [1, "failed", "unknown"],
        [2, "completed", "complete"],
      ]);
      expect(finished[1]!.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        throw new ModelRequestFailure("unauthorized", {
          kind: "authentication",
          phase: "request",
          retryable: false,
        });
      },
    };
    await expect(collect(client)).rejects.toMatchObject({
      info: { kind: "authentication", retryable: false },
    });
    expect(calls).toBe(1);
  });

  it("stops waiting and issues no further request when cancelled", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const controller = new AbortController();
      const interrupted = new Error("stopped");
      const client = {
        streamMessage: async function* (params: StreamMessageParams): AsyncIterable<StreamEvent> {
          calls++;
          params.abortSignal?.throwIfAborted();
          throw new ModelRequestFailure("reset", {
            kind: "network",
            phase: "request",
            retryable: true,
          });
        },
      };

      const run = (async () => {
        for await (const _ of streamBufferedModelWithRetry(
          client as never,
          {
            model: "m",
            messages: [{ type: "user", content: "p" }],
            abortSignal: controller.signal,
          },
        )) { /* drain */ }
      })();
      let rejection: unknown;
      void run.catch((error) => { rejection = error; });

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      controller.abort(interrupted);
      await vi.advanceTimersByTimeAsync(0);
      expect(rejection).toBe(interrupted);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to wrap a tool-bearing main generation", async () => {
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    await expect((async () => {
      for await (const _ of streamBufferedModelWithRetry(
        client as never,
        {
          model: "m",
          messages: [{ type: "user", content: "p" }],
          tools: [{ name: "Read", description: "r", inputSchema: { type: "object" } }],
        },
      )) { /* drain */ }
    })()).rejects.toThrow(/tool-free/);
  });

  it("marks usage unknown when the successful attempt reports no usage", async () => {
    const finished: ModelAttemptFinishedEvent[] = [];
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", delta: "ok" };
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    await collect(client, { onAttemptFinished: (event) => finished.push(event) });
    expect(finished[0]).toMatchObject({ status: "completed", usageStatus: "unknown" });
    expect(finished[0]!.usage).toBeUndefined();
  });
});
