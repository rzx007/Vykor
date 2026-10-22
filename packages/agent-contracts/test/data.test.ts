import { describe, expect, it } from "vitest";
import type { Message, ModelAttemptFinishedEvent } from "../src/index.js";

describe("shared execution data", () => {
  it("retains compact markers, reasoning and tool failure metadata when persisted", () => {
    const messages: Message[] = [
      { type: "assistant", content: "summary", compactRole: "summary",
        reasoningSegments: [{ source: "reasoning_content", text: "reason" }],
        reasoningReplay: "reason", phase: "final_answer" },
      { type: "tool_result", toolUseId: "call-1", content: [], isError: true,
        failureKind: "unknown_outcome", executionState: "unknown", recoveryHint: "read first" },
    ];
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages);
  });

  it.each(["complete", "partial", "unknown"] as const)("retains %s attempt usage without inventing zeroes", usageStatus => {
    const event: ModelAttemptFinishedEvent = {
      type: "model_attempt_finished", generationId: "g1", attempt: 2,
      status: "failed", usageStatus,
      ...(usageStatus === "unknown" ? {} : { usage: { inputTokens: 7, outputTokens: 3 } }),
    };
    const persisted = JSON.parse(JSON.stringify(event));
    expect(persisted.usageStatus).toBe(usageStatus);
    if (usageStatus === "unknown") expect(persisted).not.toHaveProperty("usage");
    else expect(persisted.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
