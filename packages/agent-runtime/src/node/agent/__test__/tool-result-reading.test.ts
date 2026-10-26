import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRunScope, RunToolBinding, StreamingMessageClient, ToolResultRef } from "@vykor/agent-contracts";
import { MemoryToolResultArchive } from "@vykor/core";
import { createDefaultNodeAgent } from "../default-agent.js";

describe("Node result reading", () => {
  it.each([false, true])("binds history access to the final model and manual tool ceiling (injected=%s)", async injected => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-result-ceiling-")), archive = new MemoryToolResultArchive();
    const grants: ReadonlyMap<string, RunToolBinding>[] = [];
    let phase = 0, ref: ToolResultRef | undefined, advertised: string[] = [], listed = "", read = "";
    const agent = await createDefaultNodeAgent({ cwd, sessionId: "ceiling-session",
      settings: { model: "test-model", apiFormat: "openai", maxTurns: 5, permission: { mode: "full_auto" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
      tools: [{ name: "Large", description: "private prior result", inputSchema: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "SECRET-PRIOR-RUN" }] }) }],
      ...(injected ? { toolResults: (scope: AgentRunScope, tools: ReadonlyMap<string, RunToolBinding>) => { grants.push(tools); return archive.forRun(scope, tools); } } : {}),
      client: { async *streamMessage(params) {
        const step = phase++;
        if (step === 1) ref = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "large")?.resultRef;
        if (step === 2) advertised = params.tools!.map(tool => tool.name);
        if (step === 3) listed = JSON.stringify(params.messages.find(message => message.type === "tool_result" && message.toolUseId === "list"));
        if (step === 4) read = JSON.stringify(params.messages.find(message => message.type === "tool_result" && message.toolUseId === "read"));
        const call = step === 0 ? { id: "large", name: "Large", input: {} }
          : step === 2 ? { id: "list", name: "ToolResult", input: { action: "list" } }
          : step === 3 ? { id: "read", name: "ToolResult", input: { action: "read", id: ref?.id } } : undefined;
        if (call) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
        yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
      } } });
    try {
      await agent.runMessage("produce a private result");
      expect(ref).toBeDefined();
      agent.clear();
      const view = agent.host.plugins.createRunCapabilityView(), tools = new Map([["ToolResult", view.tools.get("ToolResult")!]]);
      await agent.runMessage("read only allowed history", { capabilityView: view, tools });
      expect(advertised).toEqual(["ToolResult"]);
      expect(listed).not.toContain("Large");
      expect(read).not.toContain("SECRET-PRIOR-RUN");
      expect(read).toContain('"isError":true');
      if (injected) expect([...grants[1]!.keys()]).toEqual(["ToolResult"]);

      const manualScope = (runId: string): AgentRunScope => ({ runId, agentId: agent.id, sessionId: agent.id, cwd, inputId: runId, traceId: runId, signal: new AbortController().signal });
      const manual = await agent.runTool({ type: "tool_use", id: "manual", name: "ToolResult", input: { action: "read", id: ref!.id } }, { tools, scope: manualScope("manual-restricted") });
      expect(manual.isError).toBe(true);
      expect(JSON.stringify(manual.content)).not.toContain("SECRET-PRIOR-RUN");
      const restored = await agent.runTool({ type: "tool_use", id: "restored", name: "ToolResult", input: { action: "read", id: ref!.id } }, { tools: view.tools, scope: manualScope("manual-restored") });
      expect(restored.isError).not.toBe(true);
      expect(JSON.stringify(restored.content)).toContain("SECRET-PRIOR-RUN");
      const changedSource = new Map(view.tools);
      changedSource.set("Large", { ...view.tools.get("Large")!, source: { kind: "plugin", id: "replacement" } });
      const replaced = await agent.runTool({ type: "tool_use", id: "replaced", name: "ToolResult", input: { action: "read", id: ref!.id } }, { tools: changedSource, scope: manualScope("manual-replaced-source") });
      expect(replaced.isError).toBe(true);
      expect(JSON.stringify(replaced.content)).not.toContain("SECRET-PRIOR-RUN");
    } finally { await agent.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each([false, true])("keeps results across Runs and gives an injected host store precedence (injected=%s)", async injected => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-results-")), events: AgentEvent[] = [];
    const archive = new MemoryToolResultArchive(), scopes: AgentRunScope[] = [];
    let phase = 0, ref: ToolResultRef | undefined, observed = "";
    const body = "x".repeat(300_000) + "TAIL-EVIDENCE";
    const client: StreamingMessageClient = { async *streamMessage(params) {
      const next = phase++;
      if (next === 3) {
        const result = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "list");
        const payload = JSON.parse(result!.content.filter(block => block.type === "text").map(block => block.text).join(""));
        ref = payload.items[0];
      }
      const toolUse = next === 0 ? { id: "large", name: "Large", input: {} }
        : next === 2 ? { id: "list", name: "ToolResult", input: { action: "list" } }
        : next === 3 ? { id: "tail", name: "ToolResult", input: { action: "read", id: ref?.id, offset: 300_000 } }
        : undefined;
      if (next === 4) observed = JSON.stringify(params.messages.find(message => message.type === "tool_result" && message.toolUseId === "tail"));
      if (toolUse) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...toolUse } };
      yield { type: "complete", stopReason: toolUse ? "tool_use" : "end_turn" };
    } };
    const agent = await createDefaultNodeAgent({ cwd, client, sessionId: "results-session",
      settings: { model: "test-model", apiFormat: "openai", maxTurns: 8, permission: { mode: "full_auto" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
      tools: [{ name: "Large", description: "large output", inputSchema: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: body }] }) }],
      ...(injected ? { toolResults: (scope: AgentRunScope, tools: ReadonlyMap<string, RunToolBinding>) => { scopes.push(scope); return archive.forRun(scope, tools); } } : {}),
      onEvent: event => { events.push(event); },
    });
    try {
      expect((await agent.runMessage("produce the result")).status).toBe("completed");
      const original = events.find(event => event.type === "tool.completed" && event.data.toolUseId === "large");
      expect(original?.data.result.resultRef).toBeDefined();
      agent.clear();
      expect((await agent.runMessage("find and read the prior result")).status).toBe("completed");
      expect(observed).toContain("TAIL-EVIDENCE");
      expect(ref).toEqual(original?.data.result.resultRef);
      for (const id of ["list", "tail"]) {
        const readerResult = events.find(event => event.type === "tool.completed" && event.data.toolUseId === id);
        expect(readerResult?.data.result.resultRef).toBeUndefined();
      }
      if (injected) {
        expect(scopes).toHaveLength(2);
        expect(scopes[0]!.runId).not.toBe(scopes[1]!.runId);
        expect((await archive.forRun({ ...scopes[1]!, signal: new AbortController().signal }, new Map([["Large", {
          definition: { name: "Large", description: "read authorized source", inputSchema: {}, execute: async () => ({ content: [] }) }, invoke: async () => ({ content: [] }), source: { kind: "agent" },
        }]])).list()).items).toHaveLength(1);
      }
    } finally { await agent.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
});
