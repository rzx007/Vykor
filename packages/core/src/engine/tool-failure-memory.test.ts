import { describe, expect, it } from "vitest";
import { ToolFailureMemory } from "./tool-failure-memory.js";

describe("ToolFailureMemory", () => {
  it("blocks an identical failure until new evidence arrives", () => {
    const memory = new ToolFailureMemory();
    memory.recordFailure("Shell", { command: "curl.exe URL" });
    expect(memory.shouldReplayFailure("Shell", { command: "curl.exe URL" })).toBe(true);
    memory.noteEvidence();
    expect(memory.shouldReplayFailure("Shell", { command: "curl.exe URL" })).toBe(false);
  });

  it("keeps distinct commands independent", () => {
    const memory = new ToolFailureMemory();
    memory.recordFailure("Shell", { command: "first" });
    expect(memory.shouldReplayFailure("Shell", { command: "second" })).toBe(false);
  });
});
