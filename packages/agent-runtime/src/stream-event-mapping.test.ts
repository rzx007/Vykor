import { describe, expect, it } from "vitest";
import { streamEventToAgentEvent } from "./framework-agent-run.js";

describe("streamEventToAgentEvent", () => {
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
