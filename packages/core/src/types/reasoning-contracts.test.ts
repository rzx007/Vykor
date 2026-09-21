import { describe, expect, it } from "vitest";
import type { ReasoningDeltaEvent, StreamEvent } from "./events.js";
import type { AssistantMessage } from "./messages.js";

describe("reasoning contracts", () => {
  it("carries reasoning deltas with their source", () => {
    const event: ReasoningDeltaEvent = {
      type: "reasoning_delta",
      delta: "先看文件。",
      source: "think",
    };
    const streamEvent: StreamEvent = event;
    expect(streamEvent.type).toBe("reasoning_delta");
  });

  it("lets assistant messages carry display and replay reasoning", () => {
    const message: AssistantMessage = {
      type: "assistant",
      content: "答案",
      reasoning: "想法",
      reasoningReplay: "想法",
    };
    expect(message.reasoningReplay).toBe("想法");
  });
});
