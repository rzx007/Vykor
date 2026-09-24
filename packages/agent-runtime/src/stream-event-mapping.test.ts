import { describe, expect, it } from "vitest";
import { FrameworkAgentRun, streamEventToAgentEvent } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";
import type { AgentEventInput, StreamEvent } from "@vykor/core";

describe("streamEventToAgentEvent", () => {
  it("forwards complete tool feedback through the SDK event bus", async () => {
    const result = {
      content: [{ type: "text" as const, text: "[tool-result kind=policy execution=not_started]" }, { type: "text" as const, text: "body".repeat(10000) }],
      isError: true, failureKind: "policy" as const, executionState: "not_started" as const,
      recoveryHint: "先检查条件", compactSummary: "policy; not_started",
      metadata: { recoveryGuard: "repeated_failed_call" },
    } satisfies Extract<AgentEventInput, { type: "tool.completed" }>["data"]["result"];
    const events: AgentEventInput[] = [];
    const run = new FrameworkAgentRun({
      agentId: "a", ids: { inputId: "i", runId: "r", traceId: "t" }, content: "work", delivery: "queue",
      eventBus: new AgentEventBus((event) => { events.push(event); }),
      session: { id: "s", getHistory: () => [], submitMessage: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_use_end", toolUseId: "call-1", result };
        yield { type: "complete", stopReason: "end_turn" };
      } } as any,
      runtime: { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any,
      effects: {} as any, children: { cwd: "/repo", createController: () => ({}) } as any, onSettled: () => {},
    });
    await run.result;
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ data: { toolUseId: "call-1", result } });
  });
  it("maps reasoning deltas to output.reasoning.delta", () => {
    expect(
      streamEventToAgentEvent({
        type: "reasoning_delta",
        delta: "想法",
        source: "reasoning_content",
      }),
    ).toEqual({
      type: "output.reasoning.delta",
      data: { delta: "想法", source: "reasoning_content" },
    });
  });

  it("maps text deltas with their phase", () => {
    expect(
      streamEventToAgentEvent({ type: "text_delta", delta: "答", phase: "commentary" }),
    ).toEqual({
      type: "output.text.delta",
      data: { delta: "答", phase: "commentary" },
    });
  });

  it("leaves other events to the caller", () => {
    expect(streamEventToAgentEvent({ type: "complete", stopReason: "stop" })).toBeUndefined();
  });
});
