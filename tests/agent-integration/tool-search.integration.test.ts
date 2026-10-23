import { ToolRegistry } from "@vykor/core/engine";
import { toolSearchTool } from "../../packages/tools/src/meta/tool-search.js";
import { expect, it } from "vitest";

it("finds MCP snake_case and kebab-case names using separated words", async () => {
    const registry = new ToolRegistry();
    for (const name of ["mcp__office_server__export_slides", "archive-project-notes"]) registry.register({
      name, description: "operation", inputSchema: {}, execute: async () => ({ content: [] }),
    });
    const context = { cwd: ".", toolRegistry: registry };
    expect(JSON.stringify(await toolSearchTool.execute({ query: "export slides", limit: 1 }, context))).toContain("mcp__office_server__export_slides");
    expect(JSON.stringify(await toolSearchTool.execute({ query: "project notes", limit: 1 }, context))).toContain("archive-project-notes");
  });

it("bounds legacy registry results and does not activate a global catalog", async () => {
    const registry = new ToolRegistry();
    for (let i = 0; i < 30; i++) registry.register({ name: `Edit${i}`, description: "edit", inputSchema: {}, async execute() { return { content: [] }; } });
    const result = await toolSearchTool.execute({ query: "edit", limit: 3 }, { cwd: ".", toolRegistry: registry });
    expect(result.content.filter(c => c.type === "text").map(c => c.text).join("\n").match(/Edit\d+/g)).toHaveLength(3);
    const defaults = await toolSearchTool.execute({ query: "edit" }, { cwd: ".", toolRegistry: registry });
    expect(JSON.stringify(defaults).match(/Edit\d+/g)).toHaveLength(5);
  });
