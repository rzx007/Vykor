import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QueryEngine, ToolRegistry } from "@vykor/core/engine";
import { createFileReadTool, createFileWriteTool } from "@vykor/tools";
import type { StreamMessageParams, ToolExecutionResult } from "@vykor/agent-contracts";

const text = (result: ToolExecutionResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

async function fixture(rule: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "oh-rule-engine-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "AGENTS.md"), rule);
    await writeFile(join(root, "nested", "data.txt"), "old\n");
    await run(root);
  } finally {
    const target = resolve(root), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("oh-rule-engine-")) throw new Error("Unsafe fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
}

async function writeThroughEngine(root: string, input: Record<string, unknown>, withRead = false, maxTurns = 20) {
  const registry = new ToolRegistry();
  const host = { settings: { model: "test", apiFormat: "openai" as const, maxTurns: 20,
    permission: { mode: "default" as const }, sandbox: { enabled: false } } };
  const write = createFileWriteTool(host), read = createFileReadTool(host);
  let readComplete: (() => void) | undefined;
  let readReady: Promise<void> | undefined;
  registry.register({ ...write, execute: async (input, context) => {
    if (readReady) await readReady;
    return write.execute(input, context);
  } }, { kind: "builtin" });
  registry.register({ ...read, execute: async (input, context) => {
    try { return await read.execute(input, context); }
    finally { readComplete?.(); }
  } }, { kind: "builtin" });
  let request = 0;
  const requests: StreamMessageParams[] = [];
  const client = { streamMessage: async function* (params: StreamMessageParams) {
    requests.push(params);
    request++;
    const last = params.messages.filter(message => message.type === "tool_result").at(-1);
    if ((last && !last.isError) || request > 15) {
      yield { type: "text_delta" as const, delta: "done" };
      yield { type: "complete" as const, stopReason: "end_turn" as const };
      return;
    }
    if (withRead) {
      readReady = new Promise<void>(resolve => { readComplete = resolve; });
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `read-${request}`, name: "Read", input: { file_path: input.file_path } } };
    }
    yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `write-${request}`, name: "Write", input: { ...input } } };
    yield { type: "complete" as const, stopReason: "tool_use" as const };
  } };
  const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
    { execute: async () => ({ blocked: false }) } as never, { cwd: root, maxTurns });
  const results: ToolExecutionResult[] = [];
  let failure: unknown;
  try {
    for await (const event of engine.submitMessage("Apply the requested change after reading applicable rules")) {
      if (event.type === "tool_use_end") results.push(event.result);
    }
  } catch (error) { failure = error; }
  return { results, failure, requests };
}

describe("scoped rules through the checked model tool loop", () => {
  it("retries the identical real Write after delivering a newly discovered small rule", async () => fixture("SMALL_NESTED_RULE", async root => {
    const { results, failure } = await writeThroughEngine(root, { file_path: "nested/data.txt", content: "new\n" });
    expect(failure).toBeUndefined();
    expect(text(results[0]!)).toContain("SMALL_NESTED_RULE");
    expect(results[0]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(results.at(-1)?.isError).toBeFalsy();
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("new\n");
  }));

  it("delivers every part of a 90 KB rule without spending ordinary precondition correction turns", async () => fixture("\\".repeat(90_000) + "REQUIRED_RULE_TAIL", async root => {
    const { results, failure, requests } = await writeThroughEngine(root, { file_path: "nested/data.txt", content: "new\n" });
    expect(failure).toBeUndefined();
    const ruleResults = results.filter(result => result.hostProjectInstructionKeys?.length);
    expect(ruleResults.length).toBeGreaterThanOrEqual(5);
    expect(ruleResults.map(text).join("\n")).toContain("REQUIRED_RULE_TAIL");
    expect(results.at(-1)?.isError).toBeFalsy();
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("new\n");
    expect(requests.some(request => request.system?.includes("Do not repeat an unchanged failed operation"))).toBe(false);
  }));

  it("keeps the repeated-failure guard for ordinary real Write conflicts", async () => fixture("NESTED_RULE", async root => {
    await writeFile(join(root, "data.txt"), "old\n");
    const { results } = await writeThroughEngine(root, { file_path: "data.txt", content: "new\n", expected_sha256: "0".repeat(64) });
    expect(results[0]?.hostProjectInstructionKeys).toBeUndefined();
    expect(results.some(result => result.metadata?.recoveryGuard === "repeated_failed_call")).toBe(true);
    expect(await readFile(join(root, "data.txt"), "utf8")).toBe("old\n");
  }));

  it("does not spend correction turns on a same-batch pending Write while Read delivers new rule parts", async () => fixture("\\".repeat(90_000) + "READ_RULE_TAIL", async root => {
    const { results, failure } = await writeThroughEngine(root, { file_path: "nested/data.txt", content: "new\n" }, true);
    expect(failure).toBeUndefined();
    const waits = results.filter(result => result.toolName === "Write" && result.isError && result.hostProjectInstructionKeys?.length === 0);
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(results.filter(result => result.toolName === "Read").map(text).join("\n")).toContain("READ_RULE_TAIL");
    expect(results.at(-1)?.isError).toBeFalsy();
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("new\n");
  }));

  it("does not exempt an oversized rule wait with no newly delivered rule parts", async () => fixture("r".repeat(1024 * 1024 + 1), async root => {
    const { results, failure } = await writeThroughEngine(root, { file_path: "nested/data.txt", content: "new\n" });
    expect(failure).toMatchObject({ name: "ToolRecoveryExceeded" });
    expect(results[0]?.hostProjectInstructionKeys).toEqual([]);
    expect(results.some(result => result.metadata?.recoveryGuard === "repeated_failed_call")).toBe(true);
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
  }));

  // New rules from another Read must not turn a hard rule limit into a pageable wait.
  it("counts a hard-limit Write as failure while other Reads deliver new rules in the same batch", async () => fixture("r".repeat(1024 * 1024 + 1), async root => {
    for (let round = 1; round <= 6; round++) {
      await mkdir(join(root, `read-${round}`));
      await writeFile(join(root, `read-${round}`, "AGENTS.md"), `READ_RULE_${round}`);
      await writeFile(join(root, `read-${round}`, "data.txt"), "read body");
    }
    const registry = new ToolRegistry();
    const host = { settings: { model: "test", apiFormat: "openai" as const, maxTurns: 20,
      permission: { mode: "default" as const }, sandbox: { enabled: false } } };
    registry.register(createFileReadTool(host), { kind: "builtin" });
    registry.register(createFileWriteTool(host), { kind: "builtin" });
    const results: ToolExecutionResult[] = [];
    let request = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      if (++request > 6) { yield { type: "complete" as const, stopReason: "end_turn" as const }; return; }
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `read-${request}`, name: "Read", input: { file_path: `read-${request}/data.txt` } } };
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `write-${request}`, name: "Write", input: { file_path: "nested/data.txt", content: `new-${request}\n` } } };
      yield { type: "complete" as const, stopReason: "tool_use" as const };
    } }, registry, { checkTool: async () => ({ action: "allow" }) },
    { execute: async () => ({ blocked: false }) } as never, { cwd: root, maxTurns: 20 });
    let failure: unknown;
    try {
      for await (const event of engine.submitMessage("Read independent files and update the protected target")) {
        if (event.type === "tool_use_end") results.push(event.result);
      }
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "ToolPreconditionsExceeded" });
    expect(request).toBe(5);
    expect(results.filter(result => result.toolName === "Read" && result.hostProjectInstructionKeys?.length)).toHaveLength(5);
    expect(results.filter(result => result.toolName === "Write").every(result => result.isError && result.executionState === "not_started")).toBe(true);
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
  }));

  it("still counts rule delivery rounds toward the real turn limit", async () => fixture("\\".repeat(90_000), async root => {
    const { results, failure } = await writeThroughEngine(root, { file_path: "nested/data.txt", content: "new\n" }, false, 2);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("maximum agentic turns");
    expect(results).toHaveLength(2);
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
  }));
});
