import { describe, expect, it } from "vitest";
import type { Message, ToolDefinition, ToolUseBlock } from "../index.js";
import { prepareToolCalls } from "./query-tool-preparation.js";
import { ToolFailureMemory } from "./tool-failure-memory.js";
import { ToolRegistry } from "./tool-registry.js";

const definition = {
  name: "Write",
  description: "write fixture",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" }, content: { type: "string" },
      content_from: { type: "string" }, overwrite: { type: "boolean" },
    },
    required: ["file_path"],
  },
  inputReuse: { property: "content", referenceProperty: "content_from" },
  execute: async () => ({ content: [] }),
} as ToolDefinition;

function call(id: string, input: Record<string, unknown>, name = "Write"): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function pair(source = call("source", { file_path: "a.txt", content: "complete body", overwrite: false })): Message[] {
  return [
    { type: "assistant", content: "", toolUses: [source] },
    { type: "tool_result", toolUseId: source.id, content: [], isError: true },
  ];
}

function prepare(input: Record<string, unknown>, history: Message[] = pair(), memory?: ToolFailureMemory) {
  const registry = new ToolRegistry();
  registry.register(definition);
  return prepareToolCalls([call("retry", input)], memory, registry, history);
}

describe("tool input reuse before authorization", () => {
  it("copies only the requested content and leaves source and model input unchanged", () => {
    const history = pair();
    const modelInput = { file_path: "b.txt", content_from: "source", overwrite: true };
    const result = prepare(modelInput, history);
    expect(result.readyForPermission[0]?.toolUse.input).toEqual({
      file_path: "b.txt", content: "complete body", overwrite: true,
    });
    expect(modelInput).toEqual({ file_path: "b.txt", content_from: "source", overwrite: true });
    expect(history[0]).toMatchObject({ toolUses: [{ input: {
      file_path: "a.txt", content: "complete body", overwrite: false,
    } }] });
  });

  it("accepts an empty file body", () => {
    const result = prepare({ file_path: "a.txt", content_from: "source" },
      pair(call("source", { file_path: "a.txt", content: "" })));
    expect(result.readyForPermission[0]?.toolUse.input).toEqual({ file_path: "a.txt", content: "" });
  });

  it.each([
    { label: "both forms", input: { file_path: "a.txt", content: "body", content_from: "source" } },
    { label: "neither form", input: { file_path: "a.txt" } },
    { label: "non-string body", input: { file_path: "a.txt", content: 42 } },
    { label: "non-string reference", input: { file_path: "a.txt", content_from: 42 } },
    { label: "empty reference", input: { file_path: "a.txt", content_from: "" } },
    { label: "unknown reference", input: { file_path: "a.txt", content_from: "missing" } },
    { label: "self reference", input: { file_path: "a.txt", content_from: "retry" } },
  ])("rejects $label before permission", ({ input }) => {
    const result = prepare(input);
    expect(result.readyForPermission).toEqual([]);
    expect(result.results[0]).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });

  it.each([
    { label: "another tool", history: pair(call("source", { content: "complete body" }, "Shell")) },
    { label: "missing source after compaction", history: [] as Message[] },
    { label: "a call without result", history: pair().slice(0, 1) },
    { label: "result before call", history: pair().reverse() },
    { label: "unresolved reference chain", history: pair(call("source", { content_from: "older" })) },
    { label: "non-string source", history: pair(call("source", { content: 42 })) },
    { label: "cross-tool duplicate ID", history: [
      ...pair(), ...pair(call("source", { content: "other body" }, "Shell")),
    ] },
    { label: "malformed source", history: pair({
      ...call("source", { content: "body" }), inputError: { reason: "invalid_json", argumentLength: 20 },
    }) },
  ])("rejects $label", ({ history }) => {
    const result = prepare({ file_path: "a.txt", content_from: "source" }, history);
    expect(result.readyForPermission).toEqual([]);
    expect(result.results[0]).toMatchObject({ failureKind: "invalid_input", executionState: "not_started" });
  });

  it("rejects a source from the current batch even if an older result has the same ID", () => {
    const registry = new ToolRegistry();
    registry.register(definition);
    const result = prepareToolCalls([
      call("source", { file_path: "a.txt", content: "new body" }),
      call("retry", { file_path: "a.txt", content_from: "source" }),
    ], undefined, registry, pair());
    expect(result.readyForPermission).toHaveLength(1);
    expect(result.results[1]).toMatchObject({ failureKind: "invalid_input", executionState: "not_started" });
  });

  it("compares the expanded content against failed input memory", () => {
    const memory = new ToolFailureMemory();
    memory.recordFailure("Write", { file_path: "a.txt", content: "complete body" });
    const result = prepare({ file_path: "a.txt", content_from: "source" }, pair(), memory);
    expect(result.readyForPermission).toEqual([]);
    expect(result.results[0]).toMatchObject({ metadata: { recoveryGuard: "repeated_failed_call" } });
    memory.noteEvidence();
    expect(prepare({ file_path: "a.txt", content_from: "source" }, pair(), memory).readyForPermission).toHaveLength(1);
  });

  it("retains wrapped reference support and schema validation", () => {
    const result = prepare({ arguments: { arguments: {
      file_path: "a.txt", content_from: "source", overwrite: true,
    } } });
    expect(result.readyForPermission[0]?.toolUse.input).toEqual({
      file_path: "a.txt", content: "complete body", overwrite: true,
    });
    expect(prepare({ file_path: "a.txt", content_from: "source", overwrite: "true" }).readyForPermission).toEqual([]);
  });

  it("does not interpret reference fields for tools without a declaration", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "Other", description: "other", inputSchema: {}, execute: async () => ({ content: [] }) });
    const input = { content_from: "source" };
    const result = prepareToolCalls([call("retry", input, "Other")], undefined, registry, pair());
    expect(result.readyForPermission[0]?.toolUse.input).toBe(input);
  });
});
