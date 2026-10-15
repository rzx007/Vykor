import { describe, expect, it } from "vitest";
import { QueryEngine, RuntimeBundle, ToolRegistry, type AgentEvent, type StreamMessageParams } from "@vykor/core";
import { createAgentKernel } from "./kernel.js";
import { disabledCapability, type ResolvedAgentCapabilities } from "./capability-resolution.js";

const capabilities: ResolvedAgentCapabilities = {
  terminal: disabledCapability(), backgroundShell: disabledCapability(), jobs: disabledCapability(),
  memory: disabledCapability(), childEnvironment: disabledCapability(), workflowRepository: disabledCapability(),
  schedules: disabledCapability(),
};

describe("goal runtime", () => {
  it.each([false, true])("uses ordinary tools and delivers a final reply with optional GoalUpdate=%s", async update => {
    const requests: StreamMessageParams[] = [];
    const events: AgentEvent[] = [];
    const invoked: string[] = [];
    const checked: string[] = [];
    const submitted: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    for (const name of ["Read", "Shell", "Write", "Agent", "JobRead"]) registry.register({
      name, description: name, inputSchema: { type: "object" },
      execute: async () => { invoked.push(name); return { content: [{ type: "text", text: "saved" }] }; },
    }, { kind: "builtin" });
    const client = { streamMessage: async function* (params: StreamMessageParams) {
      requests.push({ ...params, messages: structuredClone(params.messages) });
      const tool = requests.length === 1 ? { name: "Write", input: {} }
        : update && requests.length === 2 ? { name: "GoalUpdate", input: { status: "completed", reason: "检查当前文件后已完成" } } : undefined;
      if (tool) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `tool-${requests.length}`, ...tool } };
      else yield { type: "text_delta" as const, delta: "修改完成，当前文件已检查。" };
      yield { type: "complete" as const, stopReason: tool ? "tool_use" : "end_turn" };
    } };
    const permissions = { checkTool: async (name: string) => { checked.push(name); return { action: "allow" as const }; } };
    const hookExecutor = { register() {}, execute: async () => ({ blocked: false }) };
    const agent = await createAgentKernel({ cwd: process.cwd(), capabilities,
      settings: { model: "m", maxTurns: 5, permission: { mode: "default" } },
      effects: { requestPermission: async () => ({ status: "approved" }) }, onEvent: event => { events.push(event); },
      createRuntime: async () => {
        const engine = new QueryEngine(client, registry, permissions, hookExecutor);
        return { runtime: new RuntimeBundle({ model: "m" }, client, registry, permissions, hookExecutor, engine) };
      },
    });
    try {
      const result = await agent.runMessage("修复错误", { goal: { goalId: "g", objectiveVersion: 1,
        readSnapshot: async () => ({ goalId: "g", objectiveVersion: 1, status: "active", objective: "修复错误",
          autoTurnsUsed: 0, maxAutoTurns: 0, knownTokens: 0, usageIncomplete: false }),
        submitUpdate: async input => { submitted.push(input); return { recorded: true }; },
      } });
      expect(result.status).toBe("completed");
      expect(result.output).toBe("修改完成，当前文件已检查。");
      expect(requests).toHaveLength(update ? 3 : 2);
      expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(["Read", "Shell", "Write", "Agent", "JobRead", "GoalUpdate", "GoalRead"]);
      expect(invoked).toEqual(["Write"]);
      expect(checked).toContain("Write");
      expect(submitted).toEqual(update ? [{ status: "completed", reason: "检查当前文件后已完成" }] : []);
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("Tool-Result-Id:");
      expect(events.some(event => event.type === "domain.event" && event.data.name === "goal.assessment")).toBe(false);
      await agent.runMessage("ordinary");
      const ordinaryTools = requests.at(-1)?.tools?.map(tool => tool.name);
      expect(ordinaryTools).toContain("Write");
      expect(ordinaryTools).not.toContain("GoalUpdate");
      expect(ordinaryTools).not.toContain("GoalRead");
    } finally { await agent.close(); }
  });
});
