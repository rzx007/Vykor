import { describe, expect, it } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentExecutionContext, StreamEvent } from "../index.js";

describe("path alias conflicts at the core input boundary", () => {
  it("returns individual invalid_input results before permission and still runs a valid peer", async () => {
    const executed: string[] = [], checked: string[] = [], approved: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: "Write", description: "fixture", inputSchema: {
      type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"],
    }, execute: async input => {
      executed.push(input.file_path as string);
      return { content: [{ type: "text", text: "completed" }] };
    } }, { kind: "builtin" });
    const inputs = [
      { file_path: "private.txt", path: "public.txt", content: "body" },
      { arguments: { arguments: { file_path: "private.txt", filePath: "public.txt", content: "body" } } },
      { file_path: "valid.txt", content: "body" },
    ];
    let turn = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      if (turn++ === 0) {
        for (const [index, input] of inputs.entries()) yield {
          type: "tool_use_start", toolUse: { type: "tool_use", id: `call-${index}`, name: "Write", input },
        } as StreamEvent;
        yield { type: "complete", stopReason: "tool_calls" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } }, registry, { checkTool: async (_, input) => { checked.push(input.file_path as string); return { action: "ask" }; } },
    { register() {}, execute: async () => ({ blocked: false }) }, { trajectoryTrackerFactory: false });
    const execution = { scope: {}, emit: async () => {}, takeSteeredInputs: async () => [],
      effects: { requestPermission: async (request: { input: Record<string, unknown> }) => {
        approved.push(request.input.file_path as string); return { status: "approved" };
      } },
    } as unknown as AgentExecutionContext;
    const events: StreamEvent[] = [];
    for await (const event of engine.submitMessage("fixture", { execution })) events.push(event);
    const ends = events.filter(event => event.type === "tool_use_end");
    expect(ends).toHaveLength(3);
    expect(ends.slice(0, 2).map(event => event.result)).toMatchObject([
      { isError: true, failureKind: "invalid_input", executionState: "not_started" },
      { isError: true, failureKind: "invalid_input", executionState: "not_started" },
    ]);
    expect(ends[2]?.result).toMatchObject({ executionState: "completed" });
    expect(checked).toEqual(["valid.txt"]);
    expect(approved).toEqual(["valid.txt"]);
    expect(executed).toEqual(["valid.txt"]);
  });
});
