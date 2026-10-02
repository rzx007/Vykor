import { describe, expect, it } from "vitest";
import { QueryEngine, ToolRegistry, type AgentExecutionContext, type StreamEvent } from "@vykor/core";
import { PermissionChecker } from "./index.js";

describe("real permission checker after core schema validation", () => {
  it.each([
    { type: "object", allOf: [
      { properties: { file_path: { type: "string" } }, required: ["file_path"] },
      { properties: { path: { type: "string" } }, required: ["path"] },
    ] },
    { type: "object", anyOf: [
      { properties: { file_path: { type: "string" }, path: { type: "string" } }, required: ["file_path", "path"] },
    ] },
  ])("preserves composed business fields while checking each real path: %j", async inputSchema => {
      const registry = new ToolRegistry();
      const executed: Record<string, unknown>[] = [];
      registry.register({ name: "BusinessTool", description: "fixture", inputSchema,
        execute: async input => { executed.push(input); return { content: [{ type: "text", text: "completed" }] }; } });
      const inputs = [
        { file_path: "target.txt", path: "business.txt" },
        { file_path: "private.txt", path: "public.txt" },
        { file_path: "public.txt", path: "private.txt" },
        { file_path: "another.txt", path: "other-business.txt" },
      ];
      const checker = new PermissionChecker({ mode: "default", autoApproveTools: ["BusinessTool"],
        pathRules: [{ pattern: "public.txt", allow: true }, { pattern: "private.txt", allow: false }] });
      let turn = 0;
      const engine = new QueryEngine({ streamMessage: async function* () {
        if (turn++ === 0) {
          for (const [index, input] of inputs.entries()) yield { type: "tool_use_start", toolUse: {
            type: "tool_use", id: `composed-${index}`, name: "BusinessTool", input,
          } } as StreamEvent;
          yield { type: "complete", stopReason: "tool_calls" };
        } else yield { type: "complete", stopReason: "end_turn" };
      } }, registry, checker, { register() {}, execute: async () => ({ blocked: false }) }, { trajectoryTrackerFactory: false });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("fixture")) events.push(event);
      const ends = events.filter(event => event.type === "tool_use_end");
      expect(ends.map(event => event.result)).toMatchObject([
        { executionState: "completed" },
        { isError: true, failureKind: "permission", executionState: "not_started" },
        { isError: true, failureKind: "permission", executionState: "not_started" },
        { executionState: "completed" },
      ]);
      expect(executed).toEqual([
        { file_path: "target.txt", path: "business.txt" },
        { file_path: "another.txt", path: "other-business.txt" },
      ]);
  });

  it("rejects absolute and relative dot-segment targets before execution without changing valid input", async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    registry.register({ name: "Write", description: "fixture", inputSchema: {
      type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"],
    }, execute: async input => { executed.push(input.file_path as string); return { content: [{ type: "text", text: "completed" }] }; } }, { kind: "builtin" });
    const paths = ["/work/public/../private/a.txt", "public/../private/a.txt", "public/allowed.txt"];
    const checker = new PermissionChecker({ mode: "default", cwd: "/work", pathStyle: "posix", autoApproveTools: ["Write"],
      pathRules: [{ pattern: "/work/public/*", allow: true }, { pattern: "/work/private/*", allow: false }] });
    let turn = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      if (turn++ === 0) {
        for (const [index, file_path] of paths.entries()) yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: `path-${index}`, name: "Write", input: { file_path, content: "body" },
        } } as StreamEvent;
        yield { type: "complete", stopReason: "tool_calls" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } }, registry, checker, { register() {}, execute: async () => ({ blocked: false }) }, { cwd: "/work", trajectoryTrackerFactory: false });
    const events: StreamEvent[] = [];
    for await (const event of engine.submitMessage("fixture")) events.push(event);
    const ends = events.filter(event => event.type === "tool_use_end");
    expect(ends.map(event => event.result)).toMatchObject([
      { isError: true, failureKind: "permission", executionState: "not_started" },
      { isError: true, failureKind: "permission", executionState: "not_started" },
      { executionState: "completed" },
    ]);
    expect(executed).toEqual(["public/allowed.txt"]);
  });

  it("preserves declared business fields without masking private targets or accepting conflicting Write aliases", async () => {
    const registry = new ToolRegistry();
    const executed: Record<string, unknown>[] = [], approvals: unknown[] = [];
    registry.register({ name: "BusinessTool", description: "fixture", inputSchema: {
      type: "object", properties: { file_path: { type: "string" }, path: { type: "string" } }, required: ["file_path", "path"],
    }, execute: async input => { executed.push(input); return { content: [{ type: "text", text: "completed" }] }; } });
    registry.register({ name: "BusinessCamel", description: "fixture", inputSchema: {
      type: "object", properties: { file_path: { type: "string" }, filePath: { type: "string" } }, required: ["file_path", "filePath"],
    }, execute: async input => { executed.push(input); return { content: [{ type: "text", text: "completed" }] }; } });
    registry.register({ name: "BusinessNames", description: "fixture", inputSchema: JSON.parse(
      '{"type":"object","properties":{"constructor":{"type":"string"},"toString":{"type":"string"}},"required":["constructor","toString"]}',
    ), execute: async input => { executed.push(input); return { content: [{ type: "text", text: "completed" }] }; } });
    registry.register({ name: "Write", description: "fixture", inputSchema: {
      type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"],
    }, execute: async input => { executed.push(input); return { content: [{ type: "text", text: "completed" }] }; } }, { kind: "builtin" });
    const calls = [
      { name: "BusinessTool", input: { file_path: "target.txt", path: "business.txt" } },
      { name: "BusinessTool", input: { file_path: "private.txt", path: "public.txt" } },
      { name: "BusinessTool", input: { file_path: "public.txt", path: "private.txt" } },
      { name: "Write", input: { file_path: "private.txt", path: "public.txt", content: "body" } },
      { name: "BusinessTool", input: { file_path: "private.txt", path: "public.txt", filePath: "public.txt" } },
      { name: "BusinessTool", input: { file_path: "another.txt", path: "other-business.txt" } },
      { name: "BusinessCamel", input: { file_path: "camel-target.txt", filePath: "camel-business.txt", path: "camel-target.txt" } },
      { name: "BusinessCamel", input: { file_path: "private.txt", filePath: "business.txt", path: "private.txt" } },
      { name: "BusinessNames", input: JSON.parse('{"constructor":"business constructor","toString":"business text"}') },
    ];
    const checker = new PermissionChecker({ mode: "default", autoApproveTools: ["BusinessTool", "BusinessCamel", "BusinessNames", "Write"],
      pathRules: [{ pattern: "public.txt", allow: true }, { pattern: "private.txt", allow: false }] });
    let turn = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      if (turn++ === 0) {
        for (const [index, call] of calls.entries()) yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: `call-${index}`, ...call,
        } } as StreamEvent;
        yield { type: "complete", stopReason: "tool_calls" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } }, registry, checker, { register() {}, execute: async () => ({ blocked: false }) }, { trajectoryTrackerFactory: false });
    const execution = { scope: {}, emit: async () => {}, takeSteeredInputs: async () => [],
      effects: { requestPermission: async (request: unknown) => { approvals.push(request); return { status: "approved" }; } },
    } as unknown as AgentExecutionContext;
    const events: StreamEvent[] = [];
    for await (const event of engine.submitMessage("fixture", { execution })) events.push(event);
    const ends = events.filter(event => event.type === "tool_use_end");
    expect(ends).toHaveLength(9);
    expect(ends.map(event => event.result)).toMatchObject([
      { executionState: "completed" },
      { isError: true, failureKind: "permission", executionState: "not_started" },
      { isError: true, failureKind: "permission", executionState: "not_started" },
      { isError: true, failureKind: "invalid_input", executionState: "not_started" },
      { isError: true, failureKind: "invalid_input", executionState: "not_started" },
      { executionState: "completed" },
      { executionState: "completed" },
      { isError: true, failureKind: "permission", executionState: "not_started" },
      { executionState: "completed" },
    ]);
    expect(executed).toEqual([
      { file_path: "target.txt", path: "business.txt" },
      { file_path: "another.txt", path: "other-business.txt" },
      { file_path: "camel-target.txt", filePath: "camel-business.txt", path: "camel-target.txt" },
      { constructor: "business constructor", toString: "business text" },
    ]);
    expect(approvals).toEqual([]);
  });
});
