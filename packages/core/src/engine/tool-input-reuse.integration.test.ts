import { describe, expect, it } from "vitest";
import type { IHookExecutor, IPermissionChecker, Message, StreamEvent, ToolDefinition, ToolUseBlock } from "../index.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

function use(id: string, input: Record<string, unknown>): StreamEvent {
  return { type: "tool_use_start", toolUse: { type: "tool_use", id, name: "Write", input } };
}

async function run(options: { denyRetry?: boolean; sameInput?: boolean } = {}) {
  const body = "PRIVATE-FILE-CONTENT\n".repeat(300);
  const retryInput = { file_path: "a.txt", content_from: "source", ...(options.sameInput ? {} : { overwrite: true }) };
  const executed: Record<string, unknown>[] = [];
  const checked: Record<string, unknown>[] = [];
  const hooked: Record<string, unknown>[] = [];
  const nextModelHistory: Message[][] = [];
  let request = 0;
  const client = {
    streamMessage: async function* (params: { messages: Message[] }): AsyncIterable<StreamEvent> {
      nextModelHistory.push(structuredClone(params.messages));
      if (request++ === 0) yield use("source", { file_path: "a.txt", content: body });
      else if (request === 2) yield use("retry", retryInput);
      yield { type: "complete", stopReason: request <= 2 ? "tool_calls" : "end_turn" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "Write", description: "fixture", inputSchema: {
      type: "object", properties: {
        file_path: { type: "string" }, content: { type: "string" },
        content_from: { type: "string" }, overwrite: { type: "boolean" },
      }, required: ["file_path"],
    },
    inputReuse: { property: "content", referenceProperty: "content_from" },
    execute: async (input: Record<string, unknown>) => {
      executed.push({ ...input });
      return input.overwrite === true
        ? { content: [], executionState: "completed" }
        : { content: [{ type: "text", text: "explicit overwrite required" }], isError: true,
          failureKind: "invalid_input", executionState: "not_started" };
    },
  } as ToolDefinition, { kind: "builtin" });
  const permissions: IPermissionChecker = { checkTool: async (_, input) => {
    checked.push({ ...input });
    return { action: options.denyRetry && input.overwrite === true ? "deny" : "allow" };
  } };
  const hooks: IHookExecutor = { register() {}, execute: async (event, context) => {
    if (event === "pre_tool_use") hooked.push({ ...context.input as Record<string, unknown> });
    return { blocked: false };
  } };
  const engine = new QueryEngine(client, registry, permissions, hooks, { trajectoryTrackerFactory: false });
  const events: StreamEvent[] = [];
  for await (const event of engine.submitMessage("write fixture")) events.push(event);
  return { body, retryInput, executed, checked, hooked, nextModelHistory, events };
}

describe("content reuse in the normal engine execution flow", () => {
  it("offers a usable source without echoing the body, then authorizes and executes expanded input", async () => {
    const result = await run();
    expect(result.retryInput).not.toHaveProperty("content");
    expect(result.executed).toEqual([
      { file_path: "a.txt", content: result.body },
      { file_path: "a.txt", content: result.body, overwrite: true },
    ]);
    expect(result.checked).toEqual(result.executed);
    expect(result.hooked).toEqual(result.executed);
    const feedback = result.nextModelHistory[1]!.filter(m => m.type === "tool_result");
    expect(JSON.stringify(feedback)).toContain("content_from");
    expect(JSON.stringify(feedback)).toContain("source");
    expect(JSON.stringify(feedback)).not.toContain("PRIVATE-FILE-CONTENT");
    expect(JSON.stringify(feedback)).toMatch(/current retained history/i);
    expect(JSON.stringify(feedback)).toMatch(/restor.*compact.*invalid/i);
    expect(JSON.stringify(feedback)).toContain("Supply the explicit target and intent options in the new call.");
    expect(JSON.stringify(feedback)).toContain("Reusing data does not inherit authorization; normal permissions and state checks still apply.");
  });

  it("does not execute a referenced write denied by current permissions", async () => {
    const result = await run({ denyRetry: true });
    expect(result.executed).toHaveLength(1);
    expect(result.checked[1]).toEqual({ file_path: "a.txt", content: result.body, overwrite: true });
    expect(result.events.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { failureKind: "permission", executionState: "not_started" },
    });
  });

  it("does not bypass repeated-failure protection by replacing the body with a reference", async () => {
    const result = await run({ sameInput: true });
    expect(result.executed).toHaveLength(1);
    expect(result.checked).toHaveLength(1);
    expect(result.events.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { metadata: { recoveryGuard: "repeated_failed_call" } },
    });
  });
});
