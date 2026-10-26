import { describe, expect, it } from "vitest";
import type { AgentRunScope, RunToolBinding, ToolExecutionResult } from "@vykor/agent-contracts";
import { isToolResultReader, markToolResultReader, MemoryToolResultArchive } from "../index.js";
import { toolDefinitionIdentity } from "../../tools/tool-definition-identity.js";

const scope = (sessionId = "session", runId = "run", controller = new AbortController()): AgentRunScope => ({ sessionId, runId, agentId: sessionId, inputId: "input", traceId: "trace", cwd: "/work", signal: controller.signal });
const invoke = async () => ({ content: [] });
const binding: RunToolBinding = { definition: { name: "Read", description: "read", inputSchema: {}, execute: invoke }, invoke, source: { kind: "plugin", id: "selected" } };
const tools = () => new Map([["Read", binding]]);
const result = (text: string, toolUseId = "call"): ToolExecutionResult => ({ toolUseId, toolName: "Read", content: [{ type: "text", text }] });

describe("bounded memory tool result archive", () => {
  it("preserves long tails, paginates without gaps and lists historical references in a later Run", async () => {
    const archive = new MemoryToolResultArchive(), run = archive.forRun(scope(), tools());
    const body = "x".repeat(300_000) + "TAIL-EVIDENCE", output = result(body);
    const ref = await run.retain(output);
    expect(await run.retain(output)).toEqual(ref);
    expect((await run.read({ id: ref.id, offset: 300_000 })).text).toBe("TAIL-EVIDENCE");
    const later = archive.forRun(scope("session", "later"), tools());
    expect((await later.list()).items).toEqual([ref]);
    let offset = 0, collected = "";
    while (true) {
      const page = await later.read({ id: ref.id, offset, limit: 16_000 });
      collected += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(collected).toBe(body);
    expect((await later.search({ id: ref.id, query: "TAIL-EVIDENCE" })).matches).toEqual([{ offset: 300_000, text: "TAIL-EVIDENCE" }]);
  });
  it("rejects forged metadata, other sessions and revoked sources", async () => {
    const archive = new MemoryToolResultArchive(), bindings = tools(), run = archive.forRun(scope(), bindings);
    const output = { ...result("saved"), resultRef: { id: "forged", toolName: "Other", totalChars: 1 } };
    const ref = await run.retain(output);
    expect(ref.id).not.toBe("forged");
    await expect(archive.forRun(scope("other"), tools()).read({ id: ref.id })).rejects.toThrow();
    await expect(archive.forRun(scope("session", "later"), new Map([["Read", { ...binding, source: { kind: "plugin", id: "other" } }]])).read({ id: ref.id })).rejects.toThrow();
    bindings.delete("Read");
    expect((await run.list()).items).toEqual([]);
    await expect(run.read({ id: ref.id })).rejects.toThrow();
  });
  it("evicts oldest entries, explicitly rejects oversized retention and hides image data", async () => {
    const archive = new MemoryToolResultArchive({ maxEntries: 1, maxTotalChars: 100 });
    const run = archive.forRun(scope(), tools()), old = await run.retain(result("old"));
    await expect(run.retain(result("x".repeat(101), "too-big"))).rejects.toThrow(/capacity/i);
    expect((await run.read({ id: old.id })).text).toBe("old");
    const image = await run.retain({ toolName: "Read", toolUseId: "image", content: [{ type: "image", source: { type: "file", path: "/private/secret.png", mediaType: "image/png" } }] });
    await expect(run.read({ id: old.id })).rejects.toThrow(/unavailable|expired/i);
    expect((await run.read({ id: image.id })).text).toBe("[image content omitted]");
  });
  it("validates bounds and performs literal search including overlapping matches", async () => {
    const run = new MemoryToolResultArchive().forRun(scope(), tools()), ref = await run.retain(result("aaa.*tail"));
    for (const input of [{ offset: -1 }, { offset: 0.1 }, { offset: Infinity }, { offset: 100 }, { limit: 0 }, { limit: 16_001 }]) await expect(run.read({ id: ref.id, ...input })).rejects.toThrow();
    for (const input of [{ offset: -1 }, { limit: 101 }]) await expect(run.list(input)).rejects.toThrow();
    for (const query of ["", "x".repeat(1001)]) await expect(run.search({ id: ref.id, query })).rejects.toThrow();
    expect((await run.search({ id: ref.id, query: ".*" })).matches).toEqual([{ offset: 3, text: ".*" }]);
    const first = await run.search({ id: ref.id, query: "aa", limit: 1 });
    expect(first.matches).toEqual([{ offset: 0, text: "aa" }]);
    expect((await run.search({ id: ref.id, query: "aa", offset: first.nextOffset })).matches).toEqual([{ offset: 1, text: "aa" }]);
  });
  it("denies a released Run and rejects mismatched claimed sources", async () => {
    const controller = new AbortController(), run = new MemoryToolResultArchive().forRun(scope("session", "run", controller), tools());
    await expect(run.retain(result("x"), { kind: "builtin" })).rejects.toThrow();
    controller.abort();
    await expect(run.list()).rejects.toThrow();
  });
  it("invalidates a normally completed Run without removing history for later Runs", async () => {
    const archive = new MemoryToolResultArchive(), run = archive.forRun(scope(), tools()), ref = await run.retain(result("history"));
    archive.releaseRun("run");
    await expect(run.list()).rejects.toThrow();
    expect((await archive.forRun(scope("session", "later"), tools()).read({ id: ref.id })).text).toBe("history");
  });
  it("never promises a complete reference for an unknown execution outcome", async () => {
    const run = new MemoryToolResultArchive().forRun(scope(), tools());
    await expect(run.retain({ ...result("partial"), executionState: "unknown" })).rejects.toThrow();
    expect((await run.list()).items).toEqual([]);
  });
  it("recognizes captured reader clones only with the trusted identity and original execute function", () => {
    const definition = markToolResultReader({ ...binding.definition });
    const identity = toolDefinitionIdentity(definition), captured = Object.freeze({ ...definition });
    expect(isToolResultReader(captured, identity)).toBe(true);
    expect(isToolResultReader(captured, Symbol("spoof"))).toBe(false);
    expect(isToolResultReader({ ...captured, execute: async () => ({ content: [] }) }, identity)).toBe(false);
    definition.execute = async () => ({ content: [] });
    expect(isToolResultReader(definition)).toBe(false);
  });
});
