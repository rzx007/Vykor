import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IToolRegistry, ToolDefinition } from "@vykor/core";
import { loadNativePlugin, validateNativePlugin } from "@vykor/plugins";
import { describe, expect, it } from "vitest";
import { activateNativePluginTools } from "./activate.js";

const sampleRoot = fileURLToPath(new URL("../../../../examples/plugins/text-inspector/", import.meta.url));

class TestRegistry implements IToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.tools.set(tool.name, tool); }
  unregister(name: string): boolean { return this.tools.delete(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  getAll(): ToolDefinition[] { return [...this.tools.values()]; }
  has(name: string): boolean { return this.tools.has(name); }
}

async function withInspector(run: (tool: ToolDefinition, cwd: string) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-text-inspector-"));
  const registry = new TestRegistry();
  const cleanups: Array<() => Promise<void> | void> = [];
  let activation: Awaited<ReturnType<typeof activateNativePluginTools>> | undefined;
  try {
    const validation = await validateNativePlugin(sampleRoot);
    expect(validation.status, JSON.stringify(validation.diagnostics)).toBe("valid");
    const plugin = await loadNativePlugin(validation.plugin!);
    activation = await activateNativePluginTools(plugin, {
      cwd, toolRegistry: registry, addCleanup: (cleanup) => cleanups.push(cleanup),
    });
    expect(activation.state, JSON.stringify(activation.diagnostics)).toBe("active");
    expect(registry.has("TextInspectorCheck")).toBe(true);
    await run(registry.get("TextInspectorCheck")!, cwd);
  } finally {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
      expect(registry.getAll()).toEqual([]);
      if (activation?.host) expect(activation.host.state).toBe("inactive");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

describe("text-inspector reference plugin (real child process)", () => {
  it.each([
    { name: "mixed problems", text: "ok  \n\titem\n", findings: [
      { line: 1, code: "trailing-whitespace" }, { line: 2, code: "tab-indentation" },
    ] },
    { name: "empty text", text: "", findings: [] },
    { name: "CRLF", text: "ok  \r\n\titem\r\nclean\r\n", findings: [
      { line: 1, code: "trailing-whitespace" }, { line: 2, code: "tab-indentation" },
    ] },
    { name: "same-line ordering and trailing tab", text: "\titem \nend\t", findings: [
      { line: 1, code: "tab-indentation" }, { line: 1, code: "trailing-whitespace" },
      { line: 2, code: "trailing-whitespace" },
    ] },
    { name: "only one final CR is removed", text: "x \r\r\n", findings: [] },
    { name: "100000 UTF-16 units", text: "😀".repeat(50000), findings: [] },
  ])("checks $name", async ({ text, findings }) => {
    await withInspector(async (tool, cwd) => {
      expect(tool.safeToRetry).toBe(true);
      await expect(tool.execute({ text }, { cwd })).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify({ findings, truncated: false }) }],
      });
    });
  });

  it.each([100, 101])("limits %i findings without reordering", async (count) => {
    await withInspector(async (tool, cwd) => {
      const findings = Array.from({ length: 100 }, (_, index) => ({
        line: index + 1, code: "trailing-whitespace",
      }));
      await expect(tool.execute({ text: "x \n".repeat(count) }, { cwd })).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify({ findings, truncated: count > 100 }) }],
      });
    });
  });

  it("counts two issues on a line separately at the limit", async () => {
    await withInspector(async (tool, cwd) => {
      const findings = [
        ...Array.from({ length: 99 }, (_, index) => ({ line: index + 1, code: "trailing-whitespace" })),
        { line: 100, code: "tab-indentation" },
      ];
      await expect(tool.execute({ text: "x \n".repeat(99) + "\tend " }, { cwd })).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify({ findings, truncated: true }) }],
      });
    });
  });

  it.each([
    { name: "missing text", input: {} },
    { name: "non-string text", input: { text: 42 } },
    { name: "100001 UTF-16 units", input: { text: "😀".repeat(50000) + "x" } },
    { name: "extra properties", input: { text: "ok", extra: true } },
  ])("rejects $name", async ({ input }) => {
    await withInspector(async (tool, cwd) => {
      await expect(tool.execute(input, { cwd })).rejects.toMatchObject({ code: "tool_input_invalid" });
    });
  });
});
