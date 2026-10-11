import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IToolRegistry, ToolDefinition } from "@vykor/core";
import { loadNativePlugin, requestedPluginPermissions, validateNativePlugin } from "@vykor/plugins";
import { SkillRegistry } from "@vykor/skills";
import { describe, expect, it } from "vitest";
import { activateNativePluginTools } from "./activate.js";

const pluginRoot = fileURLToPath(new URL("../../../../plugins/knowledge-work/", import.meta.url));

class TestRegistry implements IToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.tools.set(tool.name, tool); }
  unregister(name: string): boolean { return this.tools.delete(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  getAll(): ToolDefinition[] { return [...this.tools.values()]; }
  has(name: string): boolean { return this.tools.has(name); }
}

async function withKnowledge(run: (tool: ToolDefinition, cwd: string) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-knowledge-work-"));
  const registry = new TestRegistry();
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    const validation = await validateNativePlugin(pluginRoot);
    expect(validation.status, JSON.stringify(validation.diagnostics)).toBe("valid");
    expect(requestedPluginPermissions(validation.plugin!.manifest)).toEqual([]);
    const plugin = await loadNativePlugin(validation.plugin!);
    expect(plugin.diagnostics.filter(item => item.severity === "error")).toEqual([]);
    const activation = await activateNativePluginTools(plugin, {
      cwd, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup),
    });
    expect(activation.state, JSON.stringify(activation.diagnostics)).toBe("active");
    await run(registry.get("KnowledgeResearchCheck")!, cwd);
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    expect(registry.getAll()).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }
}

function output(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

const source = { id: "s1", url: "https://example.com/docs", text: "Supports text files.\nPDF files are not supported." };

describe("knowledge-work official plugin (real Tool Host)", () => {
  it("loads both experts and resolves the skill names used by their instructions", async () => {
    const validation = await validateNativePlugin(pluginRoot);
    expect(validation.status, JSON.stringify(validation.diagnostics)).toBe("valid");
    const plugin = await loadNativePlugin(validation.plugin!);
    expect(plugin.components.agents?.value?.map(agent => agent.name)).toEqual([
      "vykor.knowledge-work:researcher", "vykor.knowledge-work:writer",
    ]);
    const skills = new SkillRegistry();
    for (const skill of plugin.components.skills?.value ?? []) skills.register(skill);
    for (const name of ["knowledge-research", "knowledge-write", "knowledge-organize"]) {
      expect(skills.resolve(name)?.source).toBe("plugin");
      expect(skills.resolve(`knowledge-work:${name}`)).toBe(skills.resolve(name));
    }
  });

  it("checks source and quote bindings without claiming semantic verification", async () => {
    await withKnowledge(async (tool, cwd) => {
      expect(tool.safeToRetry).toBe(true);
      const result = output(await tool.execute({ sources: [source], claims: [{
        id: "c1", text: "Supports text files but not PDF.", evidence: [
          { sourceId: "s1", quote: "Supports text files. PDF files are not supported." },
        ],
      }] }, { cwd }));
      expect(result).toMatchObject({ attributionPassed: true, semanticVerification: "not_performed", findings: [], checkedClaims: 1 });
    });
  });

  it("reports missing evidence, unknown sources and altered quotes by claim", async () => {
    await withKnowledge(async (tool, cwd) => {
      const result = output(await tool.execute({ sources: [source], claims: [
        { id: "empty", text: "Fastest tool", evidence: [] },
        { id: "missing", text: "Supports PDF", evidence: [{ sourceId: "absent", quote: "Supports PDF" }] },
        { id: "changed", text: "Supports PDF", evidence: [{ sourceId: "s1", quote: "PDF files are supported." }] },
      ] }, { cwd }));
      expect(result.attributionPassed).toBe(false);
      expect(result.findings).toEqual([
        { claimId: "empty", code: "missing_evidence" },
        { claimId: "missing", sourceId: "absent", code: "unknown_source" },
        { claimId: "changed", sourceId: "s1", code: "quote_not_found" },
      ]);
    });
  });

  it("accepts local material references without reading them", async () => {
    await withKnowledge(async (tool, cwd) => {
      const result = output(await tool.execute({ sources: [{ id: "notes", path: "materials/notes.md", text: "已有资料" }], claims: [
        { id: "c", text: "资料中的内容", evidence: [{ sourceId: "notes", quote: "已有资料" }] },
      ] }, { cwd }));
      expect(result.attributionPassed).toBe(true);
    });
  });

  it("rejects ambiguous source and claim identities rather than checking against the wrong record", async () => {
    await withKnowledge(async (tool, cwd) => {
      await expect(tool.execute({ sources: [source, { ...source, text: "different" }], claims: [] }, { cwd })).rejects.toThrow(/Duplicate source/);
      await expect(tool.execute({ sources: [source], claims: [
        { id: "same", text: "One", evidence: [] }, { id: "same", text: "Two", evidence: [] },
      ] }, { cwd })).rejects.toThrow(/Duplicate claim/);
    });
  });

  it.each([
    { sources: [source], claims: [], extra: true },
    { sources: [{ ...source, text: "x".repeat(24001) }], claims: [] },
    { sources: [source], claims: [{ id: "c", text: "claim", evidence: [{ sourceId: "s1", quote: "" }] }] },
  ])("rejects malformed or oversized input through the host schema", async input => {
    await withKnowledge(async (tool, cwd) => {
      await expect(tool.execute(input, { cwd })).rejects.toMatchObject({ code: "tool_input_invalid" });
    });
  });
});
