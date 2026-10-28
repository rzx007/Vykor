import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import type { Message, StreamingMessageClient, ToolDefinition, ToolResultRef } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../daemon-application.js";

function removeFixture(directory: string): void {
  const withinTemp = relative(tmpdir(), directory);
  if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture cleanup escaped temporary directory");
  rmSync(directory, { recursive: true, force: true });
}

function textOf(messages: Message[]): string {
  return messages.map(message => typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.text).join("\n")).join("\n");
}

function start(store: SessionStore, client: StreamingMessageClient, tool: ToolDefinition): Promise<DaemonApplication> {
  const app = new DaemonApplication({ store,
    settings: { model: "continuation-test", apiFormat: "openai", maxTurns: 7, permission: { mode: "full_access" },
      plugins: { enabled: false }, memory: { enabled: false, sessionMemoryEnabled: false }, sandbox: { enabled: false } },
    createAgent: async context => {
      const agent = await createDefaultNodeAgent({ ...context.options, client, tools: [...(context.options.tools ?? []), tool] });
      return { agent, host: agent.host };
    }, log: () => {} });
  return app.ready().then(() => app);
}

async function prompt(application: DaemonApplication, sessionId: string, text: string) {
  const admission = await application.interactions.admitPrompt(sessionId, { items: [{ type: "text", text }] });
  return application.runControl.awaitRun(sessionId, admission.run!.id);
}

describe("daily continuation through the durable daemon", () => {
  it.each([false, true])("loads the goal, latest constraints and full-result evidence without replay (compact=%s)", async compact => {
    const directory = mkdtempSync(join(tmpdir(), "agent-daily-reopen-")), database = join(directory, "session.db");
    let store = new SessionStore({ path: database }), application: DaemonApplication | undefined;
    let mode: "initial" | "correction" | "summary" | "continue" = "initial";
    let firstCalls = 0, continuationCalls = 0, writes = 0;
    let reopenedMessages: Message[] = [], reference: ToolResultRef | undefined, evidence = "";
    const client: StreamingMessageClient = { async *streamMessage(params) {
      let call: { id: string; name: string; input: Record<string, unknown> } | undefined;
      if (mode === "initial" && firstCalls++ === 0) call = { id: "generate", name: "GenerateArtifact", input: {} };
      if (mode === "continue") {
        const step = continuationCalls++;
        if (step === 0) { reopenedMessages = structuredClone(params.messages); call = { id: "list", name: "ToolResult", input: { action: "list" } }; }
        if (step === 1) {
          const listed = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "list")!;
          reference = JSON.parse(textOf([listed])).items.find((item: ToolResultRef) => item.toolName === "GenerateArtifact");
          call = { id: "read-evidence", name: "ToolResult", input: { action: "read", id: reference?.id, offset: 90000 } };
        }
        if (step === 2) evidence = textOf(params.messages.filter(message => message.type === "tool_result" && message.toolUseId === "read-evidence"));
      }
      if (call) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
      else yield { type: "text_delta", delta: mode === "summary" ? "<summary>已有报告，下一步需要检查。</summary>" : "下一步检查报告；尚未发布。" };
      yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
    } };
    const tool: ToolDefinition = { name: "GenerateArtifact", description: "generate one local report", inputSchema: { type: "object" }, execute: async () => {
      writes++; writeFileSync(join(directory, "report.html"), "report-v1");
      return { content: [{ type: "text", text: "x".repeat(90000) + "REPORT-EVIDENCE" }], executionState: "completed",
        compactSummary: "已生成 report.html；尚未发布。" };
    } };
    try {
      application = await start(store, client, tool);
      const session = application.commands.createSession({ cwd: directory, model: "continuation-test" });
      expect((await prompt(application, session.id, "当前目标：生成并检查报告；发布前必须由我确认。" )).status).toBe("completed");
      mode = "correction";
      expect((await prompt(application, session.id, "最新约束：保留 original.txt；不要发布。" )).status).toBe("completed");
      if (compact) { mode = "summary"; await application.maintenance.compact(session.id); }
      await application.close(); application = undefined; store.close();
      store = new SessionStore({ path: database });
      mode = "continue"; application = await start(store, client, tool);
      expect(writes).toBe(1);
      expect((await prompt(application, session.id, "继续检查报告。" )).status).toBe("completed");
      expect(textOf(reopenedMessages)).toContain("发布前必须由我确认");
      expect(textOf(reopenedMessages)).toContain("保留 original.txt");
      expect(evidence).toContain("REPORT-EVIDENCE");
      expect(reference).toMatchObject({ toolName: "GenerateArtifact", totalChars: 90015 });
      expect(writes).toBe(1);
      expect(readFileSync(join(directory, "report.html"), "utf8")).toBe("report-v1");
      expect(store.conversations.listInputs(session.id)).toHaveLength(3);
      expect(store.toolResults.list(session.id).filter(row => row.toolName === "GenerateArtifact")).toHaveLength(1);
    } finally { await application?.close().catch(() => {}); store.close(); removeFixture(directory); }
  });

  it("reopens without replay and allows a new authorized call after an unknown result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-daily-unknown-")), database = join(directory, "session.db");
    let store = new SessionStore({ path: database }), application: DaemonApplication | undefined;
    let reopened = false, calls = 0, resumedCalls = 0, writes = 0;
    let observedHistory = "", feedback = "", inspected = "";
    const client: StreamingMessageClient = { async *streamMessage(params) {
      let call: { id: string; name: string; input: Record<string, unknown> } | undefined;
      if (!reopened && calls++ === 0) call = { id: "publish", name: "PublishReport", input: {} };
      if (reopened) {
        const step = resumedCalls++;
        if (step === 0) { observedHistory = textOf(params.messages); call = { id: "repeat", name: "PublishReport", input: {} }; }
        if (step === 1) {
          feedback = textOf(params.messages.filter(message => message.type === "tool_result" && message.toolUseId === "repeat"));
          call = { id: "inspect", name: "Read", input: { file_path: "published.txt" } };
        }
        if (step === 2) inspected = textOf(params.messages.filter(message => message.type === "tool_result" && message.toolUseId === "inspect"));
      }
      if (call) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
      else yield { type: "text_delta", delta: reopened ? "新请求已完成。" : "发布结果未知，先核对。" };
      yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
    } };
    const tool: ToolDefinition = { name: "PublishReport", description: "a side effect with a lost receipt", inputSchema: { type: "object" }, execute: async () => {
      writes++; writeFileSync(join(directory, "published.txt"), "published-once");
      return writes === 1
        ? { content: [{ type: "text", text: "回执连接断开，发布结果未知。" }], isError: true, executionState: "unknown", failureKind: "transport" }
        : { content: [{ type: "text", text: "new request completed" }], executionState: "completed" };
    } };
    try {
      application = await start(store, client, tool);
      const session = application.commands.createSession({ cwd: directory, model: "continuation-test" });
      await prompt(application, session.id, "发布报告，结果不确定时先核查。" );
      await application.close(); application = undefined; store.close();
      store = new SessionStore({ path: database }); reopened = true;
      application = await start(store, client, tool);
      expect(writes).toBe(1);
      expect((await prompt(application, session.id, "发起一次新的发布请求，然后检查状态。" )).status).toBe("completed");
      expect(observedHistory).toContain("发布结果未知");
      expect(feedback).toContain("new request completed");
      expect(inspected).toContain("published-once");
      expect(writes).toBe(2);
      expect(store.toolResults.list(session.id).filter(row => row.toolName === "PublishReport")).toHaveLength(1);
      expect(store.conversations.listInputs(session.id)).toHaveLength(2);
    } finally { await application?.close().catch(() => {}); store.close(); removeFixture(directory); }
  });
});
