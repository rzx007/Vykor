import { describe, expect, it } from "vitest";
import type { Message } from "@vykor/agent-contracts";
import {
  boundaryFallsInsideToolGroup,
  sanitizeMessageHistory,
} from "../message-history";

describe("message history tool-call invariants", () => {
  it("keeps complete parallel tool call groups", () => {
    const messages: Message[] = [
      { type: "user", content: "run" },
      {
        type: "assistant",
        content: "",
        toolUses: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
      { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "A" }] },
      { type: "tool_result", toolUseId: "b", content: [{ type: "text", text: "B" }] },
    ];

    expect(sanitizeMessageHistory(messages)).toEqual(messages);
  });

  it("drops incomplete tool call groups and orphan tool results", () => {
    const messages: Message[] = [
      { type: "tool_result", toolUseId: "orphan", content: [{ type: "text", text: "x" }] },
      { type: "user", content: "run" },
      {
        type: "assistant",
        content: "",
        toolUses: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
      { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "A" }] },
      { type: "user", content: "continue" },
    ];

    expect(sanitizeMessageHistory(messages)).toEqual([
      { type: "user", content: "run" },
      { type: "user", content: "continue" },
    ]);
  });

  it("drops tool call messages that have no usable ids", () => {
    const messages = [
      { type: "user", content: "run" },
      {
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", name: "Bash", input: {} }],
      },
      { type: "tool_result", content: [{ type: "text", text: "A" }] },
      { type: "user", content: "continue" },
    ];

    expect(sanitizeMessageHistory(messages)).toEqual([
      { type: "user", content: "run" },
      { type: "user", content: "continue" },
    ]);
  });

  it("supports OpenAI-compatible tool_calls and tool messages", () => {
    const messages = [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "pwd", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "hostname", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "cwd" },
      { role: "tool", tool_call_id: "call_b", content: "host" },
    ];

    expect(sanitizeMessageHistory(messages)).toEqual(messages);
  });

  it("detects compact boundaries inside a parallel tool call group", () => {
    const messages: Message[] = [
      { type: "user", content: "run" },
      {
        type: "assistant",
        content: "",
        toolUses: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
      { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "A" }] },
      { type: "tool_result", toolUseId: "b", content: [{ type: "text", text: "B" }] },
    ];

    expect(boundaryFallsInsideToolGroup(messages, 3)).toBe(true);
    expect(boundaryFallsInsideToolGroup(messages, 1)).toBe(false);
    expect(boundaryFallsInsideToolGroup(messages, 4)).toBe(false);
  });
});
