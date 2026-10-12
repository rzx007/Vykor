import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { loadNativePlugin, validateNativePlugin } from "@vykor/plugins";
import { describe, expect, it } from "vitest";
import { activateNativePluginTools } from "./activate.js";
import { createRunCapabilityView } from "../run-capability-view.js";
describe("plugin data and current-Run result access", () => {
  it("keeps data across versions, isolates plugin IDs, and refuses stale or evicted results", async () => {
    const temp = mkdtempSync(join(tmpdir(), "native-data-")), dataRoot = join(temp, "data");
    const paths: string[] = [];
    try {
      for (const id of ["example.first", "example.second"]) for (const version of ["1.0.0", "2.0.0"]) {
        const root = join(temp, id, version), registry = new ToolRegistry(), cleanups: Array<() => Promise<void> | void> = [];
        mkdirSync(join(root, ".vykor-plugin"), { recursive: true }); mkdirSync(join(root, "tools"));
        writeFileSync(join(root, ".vykor-plugin", "plugin.json"), JSON.stringify({ schemaVersion: 1, id, name: "data-fixture", version,
          permissions: { filesystem: ["read", "write"] }, components: { tools: [{ entry: "./tools/save.mjs", permissions: ["filesystem:read", "filesystem:write"] }] } }));
        writeFileSync(join(root, "tools", "save.mjs"), "import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'; import { join } from 'node:path'; export function registerTools() { return [{ name:'SaveActual', description:'Save actual prior output', toolResultInput:'tool_result_id', inputSchema:{type:'object',properties:{tool_result_id:{type:'string'}},additionalProperties:false}, invoke(_input,ctx) { const path=join(ctx.plugin.dataDir,'last.json'); const previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null; if(ctx.toolResult) { mkdirSync(ctx.plugin.dataDir,{recursive:true}); writeFileSync(path,JSON.stringify(ctx.toolResult)); } return {content:[{type:'text',text:JSON.stringify({dataDir:ctx.plugin.dataDir,root:ctx.plugin.root,previous,saved:ctx.toolResult})}]}; } }]; }");
        const checked = await validateNativePlugin(root); expect(checked.status).toBe("valid");
        await activateNativePluginTools(await loadNativePlugin(checked.plugin!), { cwd: root, dataRoot, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup) });
        registry.register({ name: "PlainRead", description: "controlled actual output", inputSchema: {}, execute: async () => ({ content: [{ type: "text", text: "Actual original content" }] }) });
        const view = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set([id]) }, id);
        const execution = { scope: { runId: "run", signal: new AbortController().signal }, capabilityView: view, emit: async () => {} } as never;
        const engine = new QueryEngine({} as never, registry, { checkTool: async () => ({ action: "allow" }) } as never,
          { register() {}, execute: async () => ({ blocked: false }) }, { cwd: root, sessionId: "s" });
        try {
          await engine.executeTool({ type: "tool_use", id: "read", name: "PlainRead", input: {} }, { execution });
          const saved = await engine.executeTool({ type: "tool_use", id: "save", name: "SaveActual", input: { tool_result_id: "read" } }, { execution });
          const output = JSON.parse((saved.content[0] as { text: string }).text);
          expect(output.dataDir).toBe(join(dataRoot, id)); expect(output.root).toBe(root);
          expect(output.previous).toEqual(version === "1.0.0" ? null : { toolUseId: "read", toolName: "PlainRead", content: [{ type: "text", text: "Actual original content" }] });
          expect(output.saved.content).toEqual([{ type: "text", text: "Actual original content" }]);
          expect(JSON.parse(readFileSync(join(output.dataDir, "last.json"), "utf8")).content).toEqual(output.saved.content);
          if (version === "1.0.0") paths.push(output.dataDir);
          for (let n = 0; n < 17; n++) await engine.executeTool({ type: "tool_use", id: "next-" + n, name: "PlainRead", input: {} }, { execution });
          const evicted = await engine.executeTool({ type: "tool_use", id: "evicted", name: "SaveActual", input: { tool_result_id: "read" } }, { execution });
          expect(evicted).toMatchObject({ isError: true, executionState: "not_started", failureKind: "precondition" });
          const stale = await engine.executeTool({ type: "tool_use", id: "stale", name: "SaveActual", input: { tool_result_id: "next-16" } },
            { execution: { ...execution as object, scope: { runId: "another-run", signal: new AbortController().signal } } as never });
          expect(stale).toMatchObject({ isError: true, executionState: "not_started" });
        } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
      }
      expect(paths[0]).not.toBe(paths[1]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
