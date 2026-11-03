import { describe, expect, it, vi } from "vitest";
import type { AgentExecutionContext, ToolDefinition } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { createVykorRuntime } from "../default-runtime.js";

const client = { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } };
const question = { question: "部署成哪种形式？" };

describe("AskUser authorization", () => {
  it.each(["ask", "auto_review"] as const)("opens the question directly in %s mode and waits for the answer", async approvalMode => {
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission: { mode: "ask" } },
      configuration: { client, approvalMode },
    });
    let answer!: (value: string) => void;
    const answerPromise = new Promise<string>(resolve => { answer = resolve; });
    let opened = false;
    let completed = false;
    const unusedChild = async (): Promise<never> => { throw new Error("Unexpected child invocation"); };
    const definition = runtime.toolRegistry.get("AskUser")!;
    const execution: AgentExecutionContext = {
      scope: { agentId: "a", sessionId: "s", runId: "r", inputId: "i", traceId: "t", cwd: process.cwd(), signal: new AbortController().signal },
      tools: new Map([["AskUser", { definition, source: runtime.toolRegistry.inspect("AskUser")!.source, invoke: definition.execute }]]),
      effects: {
        requestPermission: async () => ({ status: "denied", reason: "Unexpected separate tool approval" }),
        askUserPrompt: async value => {
          expect(value).toBe("部署成哪种形式？");
          opened = true;
          return answerPromise;
        },
      },
      children: { hasChildAgent: () => false, spawnChildAgent: unusedChild, sendChildInput: unusedChild, interruptChildAgent: async () => {}, awaitChildAgent: unusedChild },
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {}, observeInvocation() {},
    };
    const pending = runtime.queryEngine.executeTool({ type: "tool_use", id: "question", name: "AskUser", input: question }, { execution })
      .then(result => { completed = true; return result; });
    try {
      await vi.waitFor(() => expect(opened).toBe(true));
      expect(completed).toBe(false);
      answer("项目站点");
      await expect(pending).resolves.toMatchObject({ content: [{ type: "text", text: "项目站点" }], executionState: "completed" });
    } finally {
      answer("项目站点");
      await pending.catch(() => {});
      await runtime.close();
    }
  });

  it.each([
    { permission: { mode: "ask", deniedTools: ["AskUser"] }, configuration: {} },
    { permission: { mode: "ask" }, configuration: {}, denyRule: true },
    { permission: { mode: "ask", allowedTools: ["Read"] }, configuration: {} },
    { permission: { mode: "ask" }, configuration: { workMode: "plan" as const } },
  ] satisfies Array<{ permission: Settings["permission"]; configuration: { workMode?: "plan" }; denyRule?: boolean }>)("preserves explicit restrictions: %j", async ({ permission, configuration, denyRule }) => {
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission },
      configuration: { client, approvalMode: "auto_review", ...configuration },
    });
    try {
      if (denyRule) runtime.permissionChecker.addRule({ tool: "AskUser", action: "deny" });
      await expect(runtime.permissionChecker.checkTool("AskUser", question)).resolves.toMatchObject({ action: "deny" });
    } finally {
      await runtime.close();
    }
  });

  it("does not grant implicit approval to a replacement named AskUser", async () => {
    const replacement: ToolDefinition = { name: "AskUser", description: "Untrusted replacement", inputSchema: { type: "object" }, execute: async () => ({ content: [] }) };
    const runtime = await createVykorRuntime({
      settings: { model: "test", apiFormat: "anthropic", permission: { mode: "ask" } },
      configuration: { client, approvalMode: "auto_review", toolOverrides: [replacement] },
    });
    try {
      expect(runtime.toolRegistry.inspect("AskUser")?.source.kind).toBe("agent");
      await expect(runtime.permissionChecker.checkTool("AskUser", question)).resolves.toMatchObject({ action: "ask" });
    } finally {
      await runtime.close();
    }
  });
});
