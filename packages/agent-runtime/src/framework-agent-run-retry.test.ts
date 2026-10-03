import { describe, expect, it } from "vitest";

import { FrameworkAgentRun } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";
import type { AgentEventInput, StreamEvent } from "@vykor/core";
import { QueryEngine, ToolRegistry } from "@vykor/core";

function runWith(script: StreamEvent[], usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 }) {
  const events: AgentEventInput[] = [];
  const run = new FrameworkAgentRun({
    agentId: "a",
    ids: { inputId: "i", runId: "r", traceId: "t" },
    content: "work",
    delivery: "queue",
    eventBus: new AgentEventBus((event) => {
      events.push(event);
    }),
    session: {
      id: "s",
      getHistory: () => [],
      submitMessage: async function* (): AsyncIterable<StreamEvent> {
        for (const event of script) yield event;
      },
    } as any,
    runtime: { queryEngine: { getTotalUsage: () => usage } } as any,
    effects: {} as any,
    children: { cwd: "/repo", createController: () => ({}) } as any,
    onSettled: () => {},
  });
  return { run, events };
}

describe("FrameworkAgentRun model retry projection", () => {
  it("reports exhausted tool input corrections as a failed run with serialized actionable feedback", async () => {
    let requests = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "Write", description: "in-memory input refusal",
      inputSchema: { type: "object", properties: { attempt: { type: "number" } } },
      execute: async () => ({ content: [{ type: "text", text: "PRIVATE-BODY" }], isError: true,
        failureKind: "invalid_input", executionState: "not_started", recoveryHint: "确认完整覆盖时传 overwrite=true。" }),
    });
    const client = { async *streamMessage(): AsyncIterable<StreamEvent> {
      const attempt = ++requests;
      if (attempt <= 3) yield { type: "tool_use_start", toolUse: {
        type: "tool_use", id: "bad-" + attempt, name: "Write", input: { attempt },
      } };
      else yield { type: "text_delta", delta: "<｜DSML｜tool_calls>not executed</｜DSML｜tool_calls>" };
      yield { type: "complete", stopReason: attempt <= 3 ? "tool_use" : "end_turn" };
    } };
    const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
      { register() {}, execute: async () => ({ blocked: false }) }, { trajectoryTrackerFactory: false });
    const events: AgentEventInput[] = [];
    const run = new FrameworkAgentRun({
      agentId: "a", ids: { inputId: "i", runId: "r", traceId: "t" }, content: "fixture", delivery: "queue",
      eventBus: new AgentEventBus(event => { events.push(event); }),
      session: { id: "s", getHistory: () => engine.getHistory(),
        submitMessage: (content: string, options: any) => engine.submitMessage(content, options) } as any,
      runtime: { queryEngine: engine } as any, effects: {} as any,
      children: { cwd: process.cwd(), createController: () => ({}) } as any, onSettled: () => {},
    });
    await expect(run.result).rejects.toMatchObject({ name: "ToolInputCorrectionsExceeded" });
    expect(requests).toBe(3);
    expect(events.filter(event => event.type === "tool.completed")).toHaveLength(3);
    expect(events.filter(event => event.type === "run.completed")).toHaveLength(0);
    const failed = events.find(event => event.type === "run.failed");
    expect(failed).toMatchObject({ data: { error: { name: "ToolInputCorrectionsExceeded",
      message: expect.stringContaining("overwrite=true") } } });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE-BODY");
  });

  it("settles only committed calls after cancellation and preserves full returned results", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel tools");
    const { run, events } = runWith([
      { type: "tool_use_start", toolUse: { type: "tool_use", id: "committed", name: "Write", input: {} } },
      { type: "tool_use_end", toolUseId: "committed", result: { content: [{ type: "text", text: "already completed" }], executionState: "completed" } },
      { type: "tool_use_end", toolUseId: "forged", result: { content: [{ type: "text", text: "must not appear" }] } },
    ]);
    const original = (run as any).options.session.submitMessage;
    (run as any).options.session.submitMessage = async function* (...args: any[]) {
      for await (const event of original(...args)) {
        if (event.type === "tool_use_end") controller.abort(reason);
        yield event;
      }
    };
    (run as any).controller = controller;
    await expect(run.result).rejects.toBe(reason);
    expect(events.filter(e => e.type === "tool.completed")).toMatchObject([
      { data: { toolUseId: "committed", result: { content: [{ type: "text", text: "already completed" }] } } },
    ]);
    expect(events.at(-1)?.type).toBe("run.interrupted");
  });

  it("projects parameter counts as domain events without committing tool activity", async () => {
    const { run, events } = runWith([
      { type: "generation_started", generationId: "g", attempt: 1 },
      { type: "tool_generation_progress", toolKey: "0", toolUseId: "proposal", toolName: "Write", receivedChars: 1024, generationId: "g", attempt: 1 },
      { type: "complete", stopReason: "end_turn" },
    ]);
    let activity: unknown;
    (run as any).options.onSettled = (_: unknown, toolActivity: unknown) => { activity = toolActivity; };
    await run.result;
    expect(events.filter(e => e.type === "domain.event")).toMatchObject([
      { data: { name: "tool.generation.progress", payload: { generationId: "g", attempt: 1, toolUseId: "proposal", receivedChars: 1024 } } },
    ]);
    expect(events.some(e => e.type === "tool.started")).toBe(false);
    expect(activity).toMatchObject({ toolUses: [], toolResults: [] });
  });
  it("projects an interrupted attempt before ending an in-flight cancelled run", async () => {
    const controller = new AbortController();
    const interrupted = new Error("cancelled while reading");
    const { run, events } = runWith([
      { type: "generation_started", generationId: "g1", attempt: 1 },
      { type: "text_delta", delta: "partial" },
      {
        type: "model_attempt_finished", generationId: "g1", attempt: 1,
        status: "interrupted", usageStatus: "unknown",
      },
      { type: "text_delta", delta: "late" },
    ]);
    const original = (run as any).options.session.submitMessage;
    (run as any).options.session.submitMessage = async function* (...args: any[]) {
      for await (const event of original(...args)) {
        if (event.type === "model_attempt_finished") controller.abort(interrupted);
        yield event;
      }
    };
    (run as any).controller = controller;
    await expect(run.result).rejects.toBe(interrupted);
    expect(events.filter((event) => event.type === "model.attempt.finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "output.text.delta").map((event: any) => event.data.delta))
      .toEqual(["partial"]);
    expect(events.at(-1)?.type).toBe("run.interrupted");
  });
  it("replaces the failed attempt's text in the final output", async () => {
    const { run, events } = runWith([
      { type: "generation_started", generationId: "g1", attempt: 1 },
      { type: "text_delta", delta: "残缺回答" },
      {
        type: "model_attempt_finished",
        generationId: "g1",
        attempt: 1,
        status: "failed",
        usageStatus: "unknown",
      },
      {
        type: "model_retry",
        generationId: "g1",
        attempt: 1,
        retryNumber: 1,
        maxRetries: 5,
        reason: "network",
        nextRetryAt: 1_000,
        recoveryDeadlineAt: 180_000,
      },
      { type: "generation_started", generationId: "g1", attempt: 2 },
      { type: "text_delta", delta: "完整回答" },
      {
        type: "model_attempt_finished",
        generationId: "g1",
        attempt: 2,
        status: "completed",
        usageStatus: "complete",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      { type: "complete", stopReason: "end_turn" },
    ]);

    const result = await run.result;
    expect(result.output).toBe("完整回答");
    const completed = events.find((event) => event.type === "run.completed");
    expect(completed && completed.type === "run.completed" && completed.data.output).toBe("完整回答");
    expect(events.filter((event) => event.type === "output.text.delta").map((event: any) => event.data.delta))
      .toEqual(["残缺回答", "完整回答"]);
    expect(events.filter((event) => event.type === "model.attempt.finished")).toHaveLength(2);
    const usageEvents = events.filter((event) => event.type === "usage.updated");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.data).toEqual({ usage: { inputTokens: 5, outputTokens: 2 } });
  });

  it("keeps an earlier successful turn's text and tools when a later generation fails", async () => {
    const { run, events } = runWith([
      { type: "generation_started", generationId: "g1", attempt: 1 },
      { type: "text_delta", delta: "回合一" },
      {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "t1", name: "Read", input: {} },
      },
      {
        type: "tool_use_end",
        toolUseId: "t1",
        result: { content: [{ type: "text", text: "ok" }] },
      },
      { type: "complete", stopReason: "tool_use" },
      { type: "generation_started", generationId: "g2", attempt: 1 },
      { type: "text_delta", delta: "坏的" },
      {
        type: "model_attempt_finished",
        generationId: "g2",
        attempt: 1,
        status: "failed",
        usageStatus: "unknown",
      },
      {
        type: "model_retry",
        generationId: "g2",
        attempt: 1,
        retryNumber: 1,
        maxRetries: 5,
        reason: "stream_incomplete",
        nextRetryAt: 1_000,
        recoveryDeadlineAt: 180_000,
      },
      { type: "generation_started", generationId: "g2", attempt: 2 },
      { type: "text_delta", delta: "回合二" },
      { type: "complete", stopReason: "end_turn" },
    ]);

    const result = await run.result;
    expect(result.output).toBe("回合一回合二");
    expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    const started = events.filter((event) => event.type === "output.generation.started");
    expect(started.map((event: any) => [event.data.generationId, event.data.attempt])).toEqual([
      ["g1", 1],
      ["g2", 1],
      ["g2", 2],
    ]);
  });

  it("carries only the last committed text boundary when a later generation fails", async () => {
    const events: AgentEventInput[] = [];
    const run = new FrameworkAgentRun({
      agentId: "a",
      ids: { inputId: "i", runId: "r", traceId: "t" },
      content: "work",
      delivery: "queue",
      eventBus: new AgentEventBus((event) => {
        events.push(event);
      }),
      session: {
        id: "s",
        getHistory: () => [],
        submitMessage: async function* (): AsyncIterable<StreamEvent> {
          yield { type: "text_delta", delta: "committed answer" };
          yield { type: "complete", stopReason: "end_turn" };
          yield { type: "text_delta", delta: "uncommitted tail" };
          throw new Error("provider down");
        },
      } as any,
      runtime: { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any,
      effects: {} as any,
      children: { cwd: "/repo", createController: () => ({}) } as any,
      onSettled: () => {},
    });

    await expect(run.result).rejects.toThrow("provider down");
    const failed = events.find((event) => event.type === "run.failed");
    expect(failed && failed.type === "run.failed" && failed.data.output).toBe("committed answer");
  });

  it("places the truncation notice before output.turn.completed", async () => {
    const { run, events } = runWith([
      { type: "generation_started", generationId: "g1", attempt: 1 },
      { type: "text_delta", delta: "正文" },
      { type: "text_delta", delta: "\n\n⚠️ *回复已被截断：本轮输出长度达到上限。可发送「继续」让模型接着写完。*" },
      { type: "complete", stopReason: "max_tokens" },
    ]);

    await run.result;
    const noticeIndex = events.findIndex(
      (event) => event.type === "output.text.delta" && event.data.delta.includes("回复已被截断"),
    );
    const completedIndex = events.findIndex((event) => event.type === "output.turn.completed");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(completedIndex);
  });
});
