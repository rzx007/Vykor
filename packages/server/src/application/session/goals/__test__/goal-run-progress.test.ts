import { describe, expect, it } from "vitest";
import type { SessionMessagePartRecord } from "@vykor/domain-contracts/sessions";
import { assessGoalRunProgress } from "../goal-run-progress.js";

function result(index: number, facts?: unknown): SessionMessagePartRecord {
  return {
    id: `part-${index}`, sessionId: "s", messageId: "m", seq: index,
    type: "tool", status: "completed", toolName: "Write", input: { file_path: "draft.txt", content: "more" },
    output: { toolUseId: `tool-${index}`, toolAttemptId: `attempt-${index}`, executionState: "completed",
      content: [{ type: "text", text: "File updated" }], ...(facts ? { hostFileFacts: facts } : {}) },
    metadata: {}, createdAt: index, updatedAt: index,
  };
}

describe("Goal run progress facts", () => {
  it("recognizes checked file changes even when the tool's display text stays the same", () => {
    let previous: unknown;
    for (let index = 1; index <= 8; index++) {
      const assessed = assessGoalRunProgress([result(index, {
        environmentKey: "local", files: [{ path: "draft.txt", subjectKey: "draft.txt", operation: "write",
          beforeDigest: `sha256:${String(index - 1).padStart(64, "0")}`,
          afterDigest: `sha256:${String(index).padStart(64, "0")}`, completed: true }],
      })], previous, "继续");
      expect(assessed.shouldPause).toBe(false);
      previous = assessed.state;
    }
  });

  it("keeps carried state bounded across long productive runs and many tools per round", () => {
    let previous: unknown;
    for (let round = 0; round < 100; round++) {
      const parts = Array.from({ length: 100 }, (_, index) => ({ ...result(index),
        output: { content: [{ type: "text", text: `${round}:${index}` }] } }));
      const assessed = assessGoalRunProgress(parts, previous, "继续");
      expect(assessed.shouldPause).toBe(false);
      expect(JSON.stringify(assessed.state).length).toBeLessThan(5_000);
      previous = assessed.state;
    }
  });
});
