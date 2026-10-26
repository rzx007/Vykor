import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import type { AgentEvent, StreamingMessageClient, ToolResultRef } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../daemon-application.js";

describe("daemon result reading wiring", () => {
  it("uses durable full results after restart and classifies the captured builtin reader as read-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-results-")), path = join(directory, "state.db");
    let store = new SessionStore({ path }), application: DaemonApplication | undefined;
    let phase = 0, original: ToolResultRef | undefined, listed: ToolResultRef | undefined, readTail = "", missing = "";
    let relistedNames: string[] = [];
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = { async *streamMessage(params) {
      const next = phase++;
      if (next === 1) original = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "large")?.resultRef;
      if (next === 3) {
        const result = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "list")!;
        listed = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("")).items.find((item: ToolResultRef) => item.toolName === "Large");
      }
      if (next === 4) readTail = JSON.stringify(params.messages.find(message => message.type === "tool_result" && message.toolUseId === "tail"));
      if (next === 6) {
        const result = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "relist")!;
        relistedNames = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("")).items.map((item: ToolResultRef) => item.toolName);
      }
      if (next === 7) missing = JSON.stringify(params.messages.find(message => message.type === "tool_result" && message.toolUseId === "missing"));
      const call = next === 0 ? { id: "large", name: "Large", input: {} }
        : next === 2 ? { id: "list", name: "ToolResult", input: { action: "list" } }
        : next === 3 ? { id: "tail", name: "ToolResult", input: { action: "read", id: listed?.id, offset: 300_000 } }
        : next === 5 ? { id: "relist", name: "ToolResult", input: { action: "list" } }
        : next === 6 ? { id: "missing", name: "ToolResult", input: { action: "read", id: "missing-result" } } : undefined;
      if (call) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
      yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
    } };
    const start = async () => {
      const app = new DaemonApplication({ store, settings: { model: "test-model", apiFormat: "openai", maxTurns: 6,
        permission: { mode: "full_access" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
        createAgent: async context => {
          const agent = await createDefaultNodeAgent({ ...context.options, client,
            tools: [...(context.options.tools ?? []), { name: "Large", description: "long source", inputSchema: { type: "object" },
              execute: async () => ({ content: [{ type: "text", text: "x".repeat(300_000) + "TAIL-EVIDENCE" }] }) }],
            onEvent: async event => { events.push(event); await context.options.onEvent?.(event); } });
          return { agent, host: agent.host };
        }, log: () => {} });
      await app.ready(); return app;
    };
    const run = async (sessionId: string) => {
      const admitted = await application!.interactions.admitPrompt(sessionId, { items: [{ type: "text", text: "continue" }] });
      return application!.runControl.awaitRun(sessionId, admitted.run!.id);
    };
    try {
      application = await start();
      const session = application.commands.createSession({ cwd: directory, model: "test-model" });
      expect((await run(session.id)).status).toBe("completed");
      expect(original).toBeDefined();
      await application.close(); store.close();
      store = new SessionStore({ path }); application = await start();
      expect((await run(session.id)).status).toBe("completed");
      expect(listed).toEqual(original);
      expect(readTail).toContain("TAIL-EVIDENCE");
      expect((await run(session.id)).status).toBe("completed");
      expect(relistedNames).toEqual(["Large"]);
      expect(missing).toContain('"isError":true');
      const operations = store.toolOperations.list({ sessionId: session.id });
      const readers = operations.filter(operation => operation.toolName === "ToolResult");
      expect(readers).toHaveLength(4);
      expect(readers.every(operation => operation.kind === "read_only" && operation.state !== "unknown")).toBe(true);
      expect(events.filter(event => event.type === "tool.completed" && event.data.result.resultRef).map(event => event.data.toolUseId)).toEqual(["large"]);
    } finally { await application?.close().catch(() => {}); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps a same-name replacement and its read-only hints outside the builtin read promise", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-result-impostor-")), store = new SessionStore({ path: join(directory, "state.db") });
    let phase = 0;
    const application = new DaemonApplication({ store,
      settings: { model: "test-model", apiFormat: "openai", maxTurns: 3, permission: { mode: "full_access" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
      createAgent: async context => {
        const agent = await createDefaultNodeAgent({ ...context.options,
          toolOverrides: [...(context.options.toolOverrides ?? []), { name: "ToolResult", description: "same-name external implementation", inputSchema: { type: "object" },
            safeToRetry: true, annotations: { readOnlyHint: true }, execute: async () => ({ content: [{ type: "text", text: "replacement body" }], executionState: "completed" }) }],
          client: { async *streamMessage() {
            if (phase++ === 0) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "impostor", name: "ToolResult", input: {} } };
            yield { type: "complete", stopReason: phase === 1 ? "tool_use" : "end_turn" };
          } } });
        return { agent, host: agent.host };
      }, log: () => {} });
    try {
      await application.ready();
      const session = application.commands.createSession({ cwd: directory, model: "test-model" });
      const admission = await application.interactions.admitPrompt(session.id, { items: [{ type: "text", text: "use replacement" }] });
      expect((await application.runControl.awaitRun(session.id, admission.run!.id)).status).toBe("completed");
      expect(store.toolOperations.list({ sessionId: session.id })).toMatchObject([{ toolName: "ToolResult", kind: "non_replayable", state: "confirmed" }]);
      const part = store.conversations.listMessageParts(session.id).find(part => part.toolUseId === "impostor")!;
      expect(part.metadata.resultRef).toMatchObject({ toolName: "ToolResult" });
    } finally { await application.close().catch(() => {}); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
