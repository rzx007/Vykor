import { describe, expect, it, vi } from "vitest";
import { type ToolDiscovery } from "@vykor/agent-contracts";
import { toolSearchTool } from "./tool-search.js";
import { ToolSearchIndex } from "./tool-search-index.js";

function discovery(hidden: string[] = []) {
  const exposed: string[] = [];
  const catalog = [
    { name: "OfficeExportSlides", description: "导出演示文稿 PPT 幻灯片", source: { kind: "plugin" as const, id: "office-work" } },
    { name: "KnowledgeWrite", description: "保存内部评估报告", source: { kind: "plugin" as const, id: "knowledge-work" } },
    { name: "Other", description: "OfficeExportSlides office export slides", source: { kind: "mcp" as const, id: "remote" } },
  ];
  const controller: ToolDiscovery = { catalog,
    getEligibleNames: () => new Set(catalog.filter(t => !hidden.includes(t.name)).map(t => t.name)),
    expose(names) { const accepted = names.filter(n => !hidden.includes(n)); exposed.push(...accepted); return accepted; },
  };
  const search = (query: unknown, limit?: unknown) => toolSearchTool.execute({ query, ...(limit === undefined ? {} : { limit }) }, { cwd: ".", toolDiscovery: controller });
  return { search, exposed, hidden };
}

describe("ToolSearch discovery", () => {
  it("searches metadata without a schema registry and exposes the selected source", async () => {
    const f = discovery(); const result = await f.search("OfficeExportSlides", 1);
    expect(result.isError).not.toBe(true);
    expect(f.exposed).toEqual(["OfficeExportSlides"]);
    expect(JSON.stringify(result)).toContain("office-work");
    expect(JSON.stringify(result)).not.toContain("inputSchema");
  });

  it("tokenizes Chinese descriptions and mixed identifiers", async () => {
    const f = discovery(); await f.search("演示文稿 PPT", 1);
    expect(f.exposed).toEqual(["OfficeExportSlides"]);
    f.exposed.length = 0; await f.search("knowledge write", 1);
    expect(f.exposed).toEqual(["KnowledgeWrite"]);
  });

  it("finds a tool by its actual source ID", async () => {
    const f = discovery(); await f.search("remote", 1);
    expect(f.exposed).toEqual(["Other"]);
  });



  it("falls back within the same eligible catalog when ranking fails", async () => {
    const f = discovery(["OfficeExportSlides"]);
    const broken = vi.spyOn(ToolSearchIndex.prototype, "search").mockImplementation(() => { throw new Error("local index unavailable"); });
    try {
      const result = await f.search("OfficeExportSlides", 1);
      expect(f.exposed).toEqual(["Other"]);
      expect(JSON.stringify(result)).not.toContain('"name":"OfficeExportSlides"');
    } finally { broken.mockRestore(); }
  });

  it("does not share an index or expose entries across Runs", async () => {
    const first = discovery(); await first.search("OfficeExportSlides", 1);
    const second = discovery(["OfficeExportSlides", "Other"]);
    expect(JSON.stringify(await second.search("slides"))).toContain("no matches");
    expect(second.exposed).toEqual([]);
  });

  it("does not report a result the host refused to expose", async () => {
    const result = await toolSearchTool.execute({ query: "private" }, { cwd: ".", toolDiscovery: {
      catalog: [{ name: "Private", description: "private" }], getEligibleNames: () => new Set(["Private"]), expose: () => [],
    } });
    expect(JSON.stringify(result)).toContain("no matches");
    expect(JSON.stringify(result)).not.toContain("Private");
  });

  it("filters ineligible tools before top K and rechecks changed eligibility", async () => {
    const f = discovery(["OfficeExportSlides"]);
    await f.search("office export slides", 1);
    expect(f.exposed).toEqual(["Other"]);
    f.hidden.push("Other"); f.exposed.length = 0;
    const result = await f.search("office export slides", 1);
    expect(f.exposed).toEqual([]);
    expect(JSON.stringify(result)).toContain("no matches");
  });

  it.each([["", undefined], [" ", undefined], [42, undefined], ["slides", 0], ["slides", 21], ["slides", 1.5]])("rejects invalid query/limit %j %j", async (query, limit) => {
    const f = discovery(); expect((await f.search(query, limit)).isError).toBe(true);
    expect(f.exposed).toEqual([]);
  });


});
