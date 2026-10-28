import { describe, expect, it } from "vitest";
import { ToolResultAccessError, toolResultList, toolResultPage, toolResultSearch, toolResultText, type RunToolResultStore, type ToolResultRef } from "@vykor/agent-contracts/tool-data";
import { createToolResultTool, isToolResultTool } from "../index.js";
async function fixture() {
  // This package is a leaf: exercise its injected host contract with the production pure page rules.
  // Memory storage/authorization is covered in core and independent SQLite storage in services/server.
  const entries = new Map<string, { ref: ToolResultRef; text: string }>();
  const get = (id: string) => { const entry = entries.get(id); if (!entry) throw new ToolResultAccessError("Result unavailable"); return entry; };
  const archive: RunToolResultStore = {
    retain: async result => { const text = toolResultText(result), ref = { id: `result_${result.toolUseId}`, toolName: result.toolName, totalChars: text.length }; entries.set(ref.id, { ref, text }); return ref; },
    list: async input => toolResultList([...entries.values()].map(entry => entry.ref), input),
    read: async input => { const entry = get(input.id); return toolResultPage(entry.ref, entry.text, input); },
    search: async input => { const entry = get(input.id); return toolResultSearch(entry.ref, entry.text, input); },
  };
  const ref = await archive.retain({ toolUseId: "call", toolName: "Read", content: [{ type: "text", text: "x".repeat(300_000) + "TAIL" }] });
  const tool = createToolResultTool(), context = { cwd: "/work", toolResults: archive };
  return { tool, context, ref };
}
describe("ToolResult builtin", () => {
  it("lists retained references and reads/searches original long output through the bound capability", async () => {
    const { tool, context, ref } = await fixture();
    const list = await tool.execute({ action: "list" }, context);
    expect(JSON.parse(list.content[0]!.type === "text" ? list.content[0]!.text : "").items).toEqual([ref]);
    const read = await tool.execute({ action: "read", id: ref.id, offset: 300_000 }, context);
    expect(read.isError).not.toBe(true);
    expect(JSON.parse(read.content[0]!.type === "text" ? read.content[0]!.text : "").text).toBe("TAIL");
    const search = await tool.execute({ action: "search", id: ref.id, query: "TAIL" }, context);
    expect(JSON.parse(search.content[0]!.type === "text" ? search.content[0]!.text : "").matches).toEqual([{ offset: 300_000, text: "TAIL" }]);
    expect(isToolResultTool(tool)).toBe(true);
    expect(isToolResultTool({ ...tool })).toBe(false);
    tool.execute = async () => ({ content: [] });
    expect(isToolResultTool(tool)).toBe(false);
  });
  it.each([{ action: "other" }, { action: "read" }, { action: "read", id: "x", limit: 16_001 }, { action: "list", limit: 101 }, { action: "search", id: "x", query: "" }, { action: "search", id: "x", query: "x", limit: 101 }, { action: "list", sessionId: "forged" }])("rejects invalid input before lookup: %j", async input => {
    const { tool, context } = await fixture();
    expect(await tool.execute(input, context)).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });
  it("reports completed read-only lookup errors without inventing a write outcome", async () => {
    const { tool, context } = await fixture();
    expect(await tool.execute({ action: "read", id: "unknown" }, context)).toMatchObject({ isError: true, failureKind: "policy", executionState: "completed" });
    expect(await tool.execute({ action: "list" }, { cwd: "/work" })).toMatchObject({ isError: true, failureKind: "policy", executionState: "completed" });
  });
  it("bounds escaped JSON pages and searches while preserving continuation offsets", async () => {
    const { tool, context } = await fixture();
    const text = "\\".repeat(20_000), ref = await context.toolResults.retain({ toolUseId: "escaped", toolName: "Read", content: [{ type: "text", text }] });
    const first = await tool.execute({ action: "read", id: ref.id, limit: 16_000 }, context);
    const payload = first.content[0]!.type === "text" ? first.content[0]!.text : "";
    expect(payload.length).toBeLessThanOrEqual(12_000);
    const page = JSON.parse(payload);
    expect(page.nextOffset).toBe(page.text.length);
    const second = await tool.execute({ action: "read", id: ref.id, offset: page.nextOffset, limit: 16_000 }, context);
    const continuation = JSON.parse(second.content[0]!.type === "text" ? second.content[0]!.text : "");
    expect(continuation.offset).toBe(page.nextOffset);
    expect(page.text + continuation.text).toBe(text.slice(0, page.text.length + continuation.text.length));
    const search = await tool.execute({ action: "search", id: ref.id, query: "\\".repeat(1000), limit: 100 }, context);
    const searchPayload = search.content[0]!.type === "text" ? search.content[0]!.text : "";
    expect(searchPayload.length).toBeLessThanOrEqual(12_000);
    const matches = JSON.parse(searchPayload);
    expect(matches.nextOffset).toBe(matches.matches.length);
    const nextSearch = await tool.execute({ action: "search", id: ref.id, query: "\\".repeat(1000), offset: matches.nextOffset, limit: 100 }, context);
    expect(JSON.parse(nextSearch.content[0]!.type === "text" ? nextSearch.content[0]!.text : "").matches[0].offset).toBe(matches.matches.length);
  });
});
