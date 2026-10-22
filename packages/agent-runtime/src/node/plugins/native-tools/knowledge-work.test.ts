import { type ToolDefinition } from "@vykor/agent-contracts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { loadNativePlugin, requestedPluginPermissions, validateNativePlugin } from "@vykor/plugins";
import { SkillRegistry } from "@vykor/skills";
import { describe, expect, it } from "vitest";
import { activateNativePluginTools } from "./activate.js";
import { createWebFetchTool } from "@vykor/tools";
import { createRunCapabilityView } from "../run-capability-view.js";

const pluginRoot = fileURLToPath(new URL("../../../../../../plugins/knowledge-work/", import.meta.url));

class TestRegistry extends ToolRegistry {}

async function withKnowledge(run: (tool: ToolDefinition, cwd: string, registry: TestRegistry, metadata: Record<string, unknown>) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-knowledge-work-"));
  const trustDirectory = mkdtempSync(join(tmpdir(), "vykor-evidence-trust-"));
  const metadata = { dataRoot: trustDirectory };
  const registry = new TestRegistry();
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    const validation = await validateNativePlugin(pluginRoot);
    expect(validation.status, JSON.stringify(validation.diagnostics)).toBe("valid");
    expect(requestedPluginPermissions(validation.plugin!.manifest)).toEqual(expect.arrayContaining([
      "filesystem:read", "network:api.openalex.org", "tool:filesystem:read", "tool:network:api.openalex.org",
    ]));
    const plugin = await loadNativePlugin(validation.plugin!);
    expect(plugin.diagnostics.filter(item => item.severity === "error")).toEqual([]);
    const activation = await activateNativePluginTools(plugin, {
      cwd, dataRoot: trustDirectory, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup),
    });
    expect(activation.state, JSON.stringify(activation.diagnostics)).toBe("active");
    await run(registry.get("KnowledgeResearchCheck")!, cwd, registry, metadata);
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    expect(registry.getAll()).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(trustDirectory, { recursive: true, force: true });
  }
}

function output(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

const source = { id: "s1", url: "https://example.com/docs", text: "Supports text files.\nPDF files are not supported." };

describe("knowledge-work official plugin (real Tool Host)", () => {
  it("loads every research/writing tool and verifies actual WebFetch records rather than supplied summaries", async () => {
    await withKnowledge(async (checker, cwd, registry) => {
      for (const name of ["KnowledgeResearchBudget", "KnowledgeEvidenceCompress", "KnowledgeAcademicSearch", "KnowledgeWritingGate", "KnowledgeContentAudit", "KnowledgeResearchSources"]) expect(registry.has(name)).toBe(true);
      const actual = "The pilot covered three teams and did not measure long-term outcomes.";
      registry.register(createWebFetchTool({ fetch: async () => ({ ok: true, url: "https://example.org/pilot", status: 200,
        contentType: "text/plain", body: actual, truncated: false }) } as never));
      const checkContext = { cwd, sessionId: "research", capabilityView: createRunCapabilityView({
        toolRegistry: registry, pluginIds: new Set(["vykor.knowledge-work"]),
      }, "vykor.knowledge-work") };
      const execution = { scope: { runId: "research-run", signal: new AbortController().signal },
        tools:checkContext.capabilityView.tools, profile:{toolResultReferences:true}, emit: async () => {} } as never;
      const engine = new QueryEngine({} as never, registry, { checkTool: async () => ({ action: "allow" }) } as never,
        { register() {}, execute: async () => ({ blocked: false }) }, { cwd, sessionId: "research" });
      await engine.executeTool({ type: "tool_use", id: "fetch", name: "WebFetch", input: { url: "https://example.org/pilot" } }, { execution });
      const imported = await engine.executeTool({ type: "tool_use", id: "import", name: "KnowledgeResearchSources",
        input: { op: "import", tool_result_id: "fetch" } }, { execution });
      registry.unregister("WebFetch");
      const ref = output(imported).source_ref;
      const result = output(await checker.execute({ op: "report", recorded_only: true,
        title: "Pilot", analysis_markdown: "## Scope\n\nThree teams only.",
        sources: [{ id: "s", url: "https://example.org/pilot", text: "A fabricated summary", source_ref: ref }],
        claims: [{ id: "c", text: "Pilot scope", citations: [{ source: "s", quote: actual }] }],
      }, checkContext));
      expect(result.attributionPassed).toBe(true);
      expect(result.claims[0].citations[0].provenance).toBe("plugin_recorded");
      expect(result.report_markdown).toContain("## Scope\n\nThree teams only.");
      const forged = output(await checker.execute({ op: "verify", recorded_only: true,
        sources: [{ id: "s", url: "https://example.org/pilot", text: "A fabricated summary", source_ref: ref }],
        claims: [{ id: "c", text: "Forged", citations: [{ source: "s", quote: "A fabricated summary" }] }],
      }, checkContext));
      expect(forged.attributionPassed).toBe(false);
      const forgedDoi = output(await checker.execute({ op: "verify", recorded_only: true,
        sources: [{ id: "s", url: "https://example.org/pilot", text: actual, source_ref: ref, doi: "10.1234/invented", date: null }],
        claims: [{ id: "c", text: "Pilot", citations: [{ source: "s", quote: actual, doi: "10.1234/invented" }] }],
      }, checkContext));
      expect(forgedDoi.attributionPassed).toBe(false);
      expect(forgedDoi.flags[0].issue).toBe("doi_not_found_in_source");
      const state = output(await registry.get("KnowledgeResearchSources")!.execute({ source_refs: [ref] }, checkContext));
      expect(state.fetch_ledger).toHaveLength(1);
      expect(state.sources[0].plugin_recorded).toBeUndefined();
      const budget = output(await registry.get("KnowledgeResearchBudget")!.execute({ op: "account", fetch_ledger: state.fetch_ledger.map((row: Record<string, unknown>) => ({ kind: row.kind, status: row.status, url: row.url })) }, { cwd }));
      expect(budget.data.totals.fetches).toBe(1);
    });
  });
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
