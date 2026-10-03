import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../types/messages.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

function scenario(validTurns: number[] = [], companion?: "completed" | "unknown") {
  const registry = new ToolRegistry();
  const executions: number[] = [];
  let requests = 0;
  registry.register({
    name: "Write", description: "in-memory input refusal",
    inputSchema: { type: "object", properties: { attempt: { type: "number" } } },
    execute: async input => {
      const attempt = input.attempt as number;
      executions.push(attempt);
      return validTurns.includes(attempt)
        ? { content: [], executionState: "completed" }
        : { content: [{ type: "text", text: "SENSITIVE-RESULT-BODY" }], isError: true,
          failureKind: "invalid_input", executionState: "not_started", recoveryHint: "确认完整替换时明确传 overwrite=true。" };
    },
  });
  if (companion) registry.register({
    name: "Companion", description: "third-batch companion",
    inputSchema: { type: "object" },
    execute: async () => companion === "completed"
      ? { content: [{ type: "text", text: "companion completed" }], executionState: "completed" }
      : { content: [{ type: "text", text: "companion outcome uncertain" }], isError: true,
        failureKind: "unknown_outcome", executionState: "unknown" },
  });
  const client = {
    async *streamMessage(): AsyncIterable<StreamEvent> {
      const attempt = ++requests;
      if (attempt > (validTurns.length ? 6 : 3)) {
        yield { type: "text_delta", delta: validTurns.length ? "finished" : "<｜DSML｜invoke name=\"Shell\">unexecuted</｜DSML｜invoke>" };
        yield { type: "complete", stopReason: "end_turn" };
        return;
      }
      yield { type: "tool_use_start", toolUse: {
        type: "tool_use", id: "write-" + attempt, name: "Write", input: { attempt },
      } };
      if (attempt === 3 && companion) yield { type: "tool_use_start", toolUse: {
        type: "tool_use", id: "companion", name: "Companion", input: {},
      } };
      yield { type: "complete", stopReason: "tool_use" };
    },
  };
  const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
    { register() {}, execute: async () => ({ blocked: false }) },
    { trajectoryTrackerFactory: false, maxTurns: 20 });
  return { engine, executions, requests: () => requests };
}

describe("terminal input correction failures", () => {
  it.each([undefined, "completed", "unknown"] as const)(
    "settles the entire last batch and stops without a model finalization request (companion: %s)",
    async companion => {
      const fixture = scenario([], companion);
      const events: StreamEvent[] = [];
      let failure: unknown;
      try { for await (const event of fixture.engine.submitMessage("fixture")) events.push(event); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: "ToolInputCorrectionsExceeded",
        message: expect.stringContaining("overwrite=true") });
      expect(String((failure as Error).message)).not.toContain("SENSITIVE-RESULT-BODY");
      expect(fixture.requests()).toBe(3);
      expect(fixture.executions).toEqual([1, 2, 3]);
      const ends = events.filter(event => event.type === "tool_use_end");
      expect(ends.filter(event => event.toolUseId.startsWith("write-"))).toHaveLength(3);
      expect(ends.filter(event => event.toolUseId.startsWith("write-")).every(event =>
        event.result.executionState === "not_started")).toBe(true);
      if (companion) expect(ends.at(-1)).toMatchObject({ toolUseId: "companion", result: { executionState: companion } });
      expect(fixture.engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(companion ? 4 : 3);
      expect(events.some(event => event.type === "text_delta" && event.delta.includes("DSML"))).toBe(false);
    },
  );

  it("resets consecutive correction failures after a successful batch", async () => {
    const fixture = scenario([3, 6]);
    for await (const _event of fixture.engine.submitMessage("fixture")) { /* consume */ }
    expect(fixture.requests()).toBe(7);
    expect(fixture.executions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fixture.engine.getHistory().at(-1)?.content).toBe("finished");
  });
});
