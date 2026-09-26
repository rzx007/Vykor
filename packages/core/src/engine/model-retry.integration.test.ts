import { describe, expect, it, vi } from "vitest";

import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { ModelRequestFailure } from "./model-retry.js";
import type { StreamEvent, ToolDefinition } from "../index.js";

function allowAll(): any {
  return { checkTool: async () => ({ action: "allow", reason: "test" }) };
}

function noopHooks(): any {
  return { execute: async () => ({ blocked: false }) };
}

function makeTool(name: string, onExecute?: () => void): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      onExecute?.();
      return { content: [{ type: "text" as const, text: `${name} result` }] };
    },
  };
}

async function collect(
  engine: QueryEngine,
  content = "start",
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of engine.submitMessage(content)) events.push(event);
  return events;
}

describe("QueryEngine model network retry", () => {
  it("projects compact attempt settlement into an active run only", async () => {
    const client = { streamMessage: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } };
      yield { type: "text_delta", delta: "summary" };
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), { trajectoryTrackerFactory: false });
    const emitted: any[] = [];
    const execution = { emit: async (event: any) => { emitted.push(event); } };
    const active = (engine as any).createCompactClient(client, "m", execution);
    for await (const _ of active.submitMessage("compact")) {}
    expect(emitted.map((event) => event.type)).toEqual(["model.attempt.finished", "usage.updated"]);
    expect(emitted[0].data.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    const standalone = (engine as any).createCompactClient(client, "m");
    for await (const _ of standalone.submitMessage("compact")) {}
    expect(emitted).toHaveLength(2);
    expect(engine.getTotalUsage()).toMatchObject({ inputTokens: 6, outputTokens: 2 });
  });

  it("does not emit into an old run when manually compacting after that run", async () => {
    const models: string[] = [];
    const resolvedClient = { streamMessage: async function* (params: any): AsyncIterable<StreamEvent> {
      models.push(params.model);
      yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } };
      yield { type: "text_delta", delta: "summary" };
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const fallback = { streamMessage: async function* (): AsyncIterable<StreamEvent> {
      throw new Error("fallback client must not be used");
    } };
    const engine = new QueryEngine(fallback, new ToolRegistry(), allowAll(), noopHooks(), {
      trajectoryTrackerFactory: false,
      resolveRequestConfiguration: async () => ({ revision: 1, model: "resolved", client: resolvedClient }),
    } as any);
    const compactService = (engine as any).compactService;
    vi.spyOn(compactService, "microCompact").mockImplementation((messages: any) => messages);
    vi.spyOn(compactService, "estimateTokens").mockReturnValue(999_999);
    vi.spyOn(compactService, "autoCompact").mockImplementation(async (messages: any) => {
      for await (const _ of compactService.client.submitMessage("summary")) {}
      return messages;
    });
    const emitted: any[] = [];
    const execution = { emit: async (event: any) => { emitted.push(event); }, closeSteering() {}, takeSteeredInputs: async () => [] };
    for await (const _ of engine.submitMessage("q", { execution: execution as any })) {}
    expect(emitted.filter((event) => event.type === "model.attempt.finished")).toHaveLength(1);
    await engine.compact();
    expect(emitted.filter((event) => event.type === "model.attempt.finished")).toHaveLength(1);
    expect(models).toEqual(["resolved", "resolved", "resolved"]);
  });
  it("settles an in-flight cancellation as interrupted with the last known usage", async () => {
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "usage", usage: { inputTokens: 8, outputTokens: 2 } };
        controller.abort(new Error("stopped"));
        throw controller.signal.reason;
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
      trajectoryTrackerFactory: false,
    });
    await expect((async () => {
      for await (const event of engine.submitMessage("q", { signal: controller.signal })) events.push(event);
    })()).rejects.toThrow("stopped");
    expect(events.filter((event) => event.type === "model_attempt_finished")).toEqual([{
      type: "model_attempt_finished", generationId: expect.any(String), attempt: 1,
      status: "interrupted", usageStatus: "partial",
      usage: { inputTokens: 8, outputTokens: 2 },
    }]);
  });
  it("retries a stream interruption and keeps only the successful answer", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            yield { type: "text_delta", delta: "残缺回答" };
            throw new ModelRequestFailure("connection reset", {
              kind: "network",
              phase: "stream",
              retryable: true,
            });
          }
          yield { type: "text_delta", delta: "完整回答" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const events: StreamEvent[] = [];
      const run = (async () => {
        for await (const event of engine.submitMessage("q")) events.push(event);
      })();
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(calls).toBe(2);
      const started = events.filter((event) => event.type === "generation_started");
      expect(started.map((event: any) => event.attempt)).toEqual([1, 2]);
      expect(events.some((event) => event.type === "model_retry")).toBe(true);
      const history = engine.getHistory();
      const assistant = history.find((message) => message.type === "assistant");
      expect(assistant?.type === "assistant" && assistant.content).toBe("完整回答");
      expect(history.some((message) =>
        message.type === "assistant" && message.content.includes("残缺回答"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits exactly one model_attempt_finished per attempt", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            throw new ModelRequestFailure("reset", {
              kind: "network",
              phase: "request",
              retryable: true,
            });
          }
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const events: StreamEvent[] = [];
      const run = (async () => {
        for await (const event of engine.submitMessage("q")) events.push(event);
      })();
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      const finished = events.filter((event) => event.type === "model_attempt_finished") as any[];
      expect(finished).toHaveLength(2);
      expect(finished.map((event) => [event.attempt, event.status, event.usageStatus])).toEqual([
        [1, "failed", "unknown"],
        [2, "completed", "complete"],
      ]);
      expect(engine.getTotalUsage()).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps request parameters frozen across retries", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const seen: any[] = [];
      const client = {
        streamMessage: async function* (params: any): AsyncIterable<StreamEvent> {
          calls++;
          seen.push({
            model: params.model,
            messages: structuredClone(params.messages),
            maxTokens: params.maxTokens,
            reasoningEffort: params.reasoningEffort,
          });
          if (calls === 1) {
            throw new ModelRequestFailure("reset", {
              kind: "network",
              phase: "request",
              retryable: true,
            });
          }
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      let revision = 1;
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
        modelRetry: { baseDelayMs: 1_000 },
        resolveRequestConfiguration: async () => ({
          revision: revision++,
          model: "model-a",
          client,
          maxOutputTokens: 4_096,
          reasoningEffort: "high",
        }),
      });

      const run = (async () => {
        for await (const _ of engine.submitMessage("q")) { /* drain */ }
      })();
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(calls).toBe(2);
      expect(seen[0].model).toBe("model-a");
      expect(seen[0].maxTokens).toBe(4_096);
      expect(seen[0].reasoningEffort).toBe("high");
      expect(seen[1]).toEqual(seen[0]);
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
          statusCode: 401,
        });
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
      trajectoryTrackerFactory: false,
    });

    await expect(collect(engine)).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "authentication", retryable: false },
    });
    expect(calls).toBe(1);
  });

  it("stops at the total retry budget when the network never recovers", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          throw new ModelRequestFailure("offline", {
            kind: "network",
            phase: "request",
            retryable: true,
          });
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
        modelRetry: { requestMaxRetries: 5, streamMaxRetries: 5, maxTotalRetries: 5 },
      });

      const run = collect(engine).catch((error) => error);
      // Let all bounded waits elapse.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await run).toMatchObject({ name: "ModelRequestFailure" });
      expect(calls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps request failures at the per-phase retry budget", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          throw new ModelRequestFailure("offline", {
            kind: "network",
            phase: "request",
            retryable: true,
          });
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const run = collect(engine).catch((error) => error);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await run).toMatchObject({ name: "ModelRequestFailure" });
      // 1 initial request + requestMaxRetries(3) retries.
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the budget when partial text keeps arriving", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          yield { type: "text_delta", delta: `片段${calls}` };
          throw new ModelRequestFailure("reset", {
            kind: "network",
            phase: "stream",
            retryable: true,
          });
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
        // Small recovery window: partial text must not extend it.
        modelRetry: { recoveryBudgetMs: 3_000, baseDelayMs: 1_000, maxDelayMs: 1_000 },
      });

      const run = collect(engine).catch((error) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await run).toMatchObject({ name: "ModelRequestFailure" });
      // First attempt + retries that fit inside the 3s recovery window.
      expect(calls).toBeLessThanOrEqual(6);
      expect(calls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry wait and issues no further request", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const controller = new AbortController();
      const interrupted = new Error("user stopped");
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          throw new ModelRequestFailure("reset", {
            kind: "network",
            phase: "request",
            retryable: true,
          });
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const events: StreamEvent[] = [];
      const run = (async () => {
        for await (const event of engine.submitMessage("q", { signal: controller.signal })) {
          events.push(event);
        }
      })();
      let rejection: unknown;
      void run.catch((error) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(events.some((event) => event.type === "model_retry")).toBe(true);
      expect(calls).toBe(1);

      controller.abort(interrupted);
      await vi.advanceTimersByTimeAsync(0);
      await run.catch(() => {});
      expect(rejection).toBe(interrupted);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repeat a tool that completed before the next model call failed", async () => {
    vi.useFakeTimers();
    try {
      let executions = 0;
      let calls = 0;
      const registry = new ToolRegistry();
      registry.register(makeTool("Read", () => { executions++; }), { kind: "builtin" });
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            yield {
              type: "tool_use_start",
              toolUse: { type: "tool_use", id: "t1", name: "Read", input: {} },
            };
            yield { type: "complete", stopReason: "tool_use" };
            return;
          }
          if (calls === 2) {
            throw new ModelRequestFailure("reset", {
              kind: "network",
              phase: "request",
              retryable: true,
            });
          }
          yield { type: "text_delta", delta: "done" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const run = collect(engine);
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      expect(executions).toBe(1);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a length-limited response as complete without retrying", async () => {
    let calls = 0;
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text_delta", delta: "正文" };
        yield { type: "complete", stopReason: "length" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
      trajectoryTrackerFactory: false,
    });

    const events = await collect(engine);
    expect(calls).toBe(1);
    expect(events.some((event) => event.type === "model_retry")).toBe(false);
    const notices = events.filter(
      (event) => event.type === "text_delta" && event.delta.includes("回复已被截断"),
    );
    expect(notices).toHaveLength(1);
    // The truncation notice must precede the final complete.
    const noticeIndex = events.findIndex(
      (event) => event.type === "text_delta" && event.delta.includes("回复已被截断"),
    );
    const completeIndex = events.findIndex((event) => event.type === "complete");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(completeIndex);
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
  });

  it("retries a network failure once, then accepts a length-limited completion", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        streamMessage: async function* (): AsyncIterable<StreamEvent> {
          calls++;
          if (calls === 1) {
            throw new ModelRequestFailure("reset", {
              kind: "network",
              phase: "request",
              retryable: true,
            });
          }
          yield { type: "text_delta", delta: "正文" };
          yield { type: "complete", stopReason: "max_tokens" };
        },
      };
      const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
        trajectoryTrackerFactory: false,
      });

      const events: StreamEvent[] = [];
      const run = (async () => {
        for await (const event of engine.submitMessage("q")) events.push(event);
      })();
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      expect(calls).toBe(2);
      const notices = events.filter(
        (event) => event.type === "text_delta" && event.delta.includes("回复已被截断"),
      );
      expect(notices).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only the latest cumulative usage snapshot per attempt", async () => {
    const client = {
      streamMessage: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
        yield { type: "usage", usage: { inputTokens: 15, outputTokens: 3 } };
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks(), {
      trajectoryTrackerFactory: false,
    });
    await collect(engine);
    expect(engine.getTotalUsage()).toMatchObject({ inputTokens: 15, outputTokens: 3 });
  });
});
