import { describe, expect, it } from "vitest";
import type { Message, ToolDefinition, ToolUseBlock } from "../index.js";
import { prepareToolCalls } from "./query-tool-preparation.js";
import { ToolFailureMemory } from "./tool-failure-memory.js";
import { ToolRegistry } from "./tool-registry.js";
import { resolveToolInputReuse, withToolInputReuseHint } from "./tool-input-reuse.js";

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

  it("reuses a unique body inside one known wrapper chain and ignores source options", () => {
    const source = call("source", { file_path: "old.txt", overwrite: false, expected_sha256: "old hash", arguments: {
      args: { content: "complete body", prepared_from: "obsolete-reference" },
    } });
    const result = prepare({ parameters: { file_path: "new.txt", overwrite: true, content_from: "source" } }, pair(source));
    expect(result.readyForPermission[0]?.toolUse.input).toEqual({ file_path: "new.txt", overwrite: true, content: "complete body" });
    expect(source.input).toEqual({ file_path: "old.txt", overwrite: false, expected_sha256: "old hash", arguments: {
      args: { content: "complete body", prepared_from: "obsolete-reference" },
    } });
  });

  it("accepts matching root and nested body values but scans all deeper layers", () => {
    const same = pair(call("source", { content: "same", args: { content: "same" } }));
    expect(prepare({ file_path: "a.txt", content_from: "source" }, same).readyForPermission[0]?.toolUse.input)
      .toEqual({ file_path: "a.txt", content: "same" });
    const different = pair(call("source", { content: "first", args: { parameters: { content: "second" } } }));
    expect(prepare({ file_path: "a.txt", content_from: "source" }, different).readyForPermission).toEqual([]);
  });

  it("uses the same source eligibility for the hint and the actual reference", () => {
    const result = { content: [{ type: "text" as const, text: "invalid input" }], isError: true,
      failureKind: "invalid_input" as const, executionState: "not_started" as const };
    for (const input of [
      { args: { content: "body" } },
      { content: "", parameters: { content: "" } },
    ]) {
      const source = call("source", input);
      const history = [{ type: "assistant" as const, content: "", toolUses: [source] }];
      expect(JSON.stringify(withToolInputReuseHint(definition, source, result, history))).toContain("content_from");
      expect(prepare({ file_path: "a.txt", content_from: "source" }, pair(source)).readyForPermission)
        .toHaveLength(1);
    }
  });

  it.each([
    ["different body", { content: "first", args: { content: "second" } }],
    ["two wrappers", { args: { content: "first" }, parameters: { content: "first" } }],
    ["non-string body", { args: { content: 123 } }],
    ["wrong wrapper type", { args: "body", content: "body" }],
    ["nested business wrapper", { args: { content: "body" } }],
  ] as const)("rejects unsafe reusable source: %s", (label, input) => {
    const source = call("source", input);
    const sourceDefinition = label === "nested business wrapper"
      ? { ...definition, inputSchema: { type: "object", properties: { args: { type: "object" } } } }
      : definition;
    const history = pair(source);
    if (sourceDefinition === definition) {
      expect(prepare({ file_path: "a.txt", content_from: "source" }, history).readyForPermission).toEqual([]);
    }
    const result = { content: [], isError: true, failureKind: "invalid_input" as const,
      executionState: "not_started" as const };
    expect(withToolInputReuseHint(sourceDefinition, source, result, history.slice(0, 1))).toBe(result);
  });

  it("rejects cyclic and over-deep reusable source chains", () => {
    const cycle: Record<string, unknown> = { content: "body" };
    cycle.args = cycle;
    let deep: Record<string, unknown> = { content: "body" };
    for (let i = 0; i < 9; i++) deep = { args: deep };
    for (const input of [cycle, deep]) {
      const source = call("source", input);
      expect(prepare({ file_path: "a.txt", content_from: "source" }, pair(source)).readyForPermission).toEqual([]);
    }
  });

  it("treats declared or composed wrapper names as business fields while retaining a root body", () => {
    for (const inputSchema of [
      { type: "object", properties: { args: { type: "object" } } },
      { type: "object", anyOf: [{ type: "object" }] },
    ]) {
      const tool = { ...definition, inputSchema } as ToolDefinition;
      const source = call("source", { content: "root body", args: { content: "business data" } });
      const retry = call("retry", { file_path: "a.txt", content_from: "source" });
      expect(resolveToolInputReuse(tool, retry, pair(source), new Set(["retry"])))
        .toEqual({ file_path: "a.txt", content: "root body" });
      const nestedOnly = call("source", { args: { content: "business data" } });
      expect(() => resolveToolInputReuse(tool, retry, pair(nestedOnly), new Set(["retry"]))).toThrow();
    }
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
