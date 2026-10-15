import { describe, expect, it } from "vitest";
import { QueryEngine, RuntimeBundle, ToolRegistry, type AgentEvent, type StreamMessageParams } from "@vykor/core";
import { createAgentKernel } from "./kernel.js";
import { createPreparationRunCapabilityView, createRunCapabilityView } from "./run-capability-view.js";
import { disabledCapability, type ResolvedAgentCapabilities } from "./capability-resolution.js";

const capabilities: ResolvedAgentCapabilities = {
  terminal: disabledCapability(), backgroundShell: disabledCapability(), jobs: disabledCapability(),
  memory: disabledCapability(), childEnvironment: disabledCapability(), workflowRepository: disabledCapability(),
  schedules: disabledCapability(),
};
const snapshot = { goalId: "g", objectiveVersion: 1, phase: "preparing" as const, objective: "修复错误",
  sourceInputIds: ["i"], requirements: [], autoTurnsUsed: 0, maxAutoTurns: 3, knownTokens: 0, usageIncomplete: false };

describe("goal preparation runtime", () => {
  it("allows four sequential read rounds then assessment without hooks or an extra model call", async () => {
    const requests: StreamMessageParams[] = [];
    const events: AgentEvent[] = [];
    const hooks: string[] = [];
    const invoked: string[] = [];
    const descriptors: unknown[] = [];
    const registry = new ToolRegistry();
    for (const name of ["Read", "Glob", "Grep", "Shell", "Write", "Agent"]) registry.register({
      name, description: name, inputSchema: { type: "object" },
      execute: async () => { invoked.push(name); return { content: [{ type: "text", text: "observed" }] }; },
    }, { kind: "builtin" });
    const client = { streamMessage: async function* (params: StreamMessageParams) {
      requests.push(params);
      if (requests.length <= 5) yield { type: "tool_use_start" as const, toolUse: {
        type: "tool_use" as const, id: `tool-${requests.length}`,
        name: requests.length <= 4 ? "Read" : "GoalAssessment",
        input: requests.length <= 4 ? {} : { decision: "ready", progress: "整理完成", evidence: [],
          progressAssessment: { kind: "progress", summary: "已整理完整条件" }, preparedRequirements: [{
            text: "修复错误", source: [{ kind: "input", inputId: "i", quote: "修复错误" }],
            verification: { kind: "check", method: "test", environment: "local", expected: "pass" }, constraints: [],
          }] },
      } };
      yield { type: "complete" as const, stopReason: requests.length <= 5 ? "tool_use" : "end_turn" };
    } };
    const permissions = { checkTool: async () => ({ action: "allow" as const }) };
    const hookExecutor = { register() {}, execute: async (name: string) => { hooks.push(name); return { blocked: false }; } };
    const agent = await createAgentKernel({ cwd: process.cwd(), capabilities,
      settings: { model: "m", maxTurns: 5, permission: { mode: "default" } },
      effects: { requestPermission: async () => ({ status: "approved" }) }, onEvent: event => { events.push(event); },
      createRuntime: async () => {
        const engine = new QueryEngine(client, registry, permissions, hookExecutor);
        return { runtime: new RuntimeBundle({ model: "m" }, client, registry, permissions, hookExecutor, engine) };
      },
    });
    try {
      const result = await agent.runMessage("prepare", { profile: { maxOutputTokens: 1024, executableHooks: false },
        limits: { check: async (boundary, tool) => { if (boundary === "tool") descriptors.push(tool); } },
        goal: { goalId: "g", objectiveVersion: 1, phase: "preparing", readSnapshot: async () => snapshot },
      });
      expect(result.status).toBe("completed");
      expect(requests).toHaveLength(5);
      expect(requests.map(request => request.maxTokens)).toEqual([1024, 1024, 1024, 1024, 1024]);
      expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(["Read", "Glob", "Grep", "GoalAssessment", "GoalRead"]);
      expect(invoked).toEqual(["Read", "Read", "Read", "Read"]);
      expect(hooks).toEqual([]);
      expect(descriptors).toEqual([1, 2, 3, 4, 5].map(index => ({
        toolName: index <= 4 ? "Read" : "GoalAssessment", toolAttemptId: `tool_attempt_tool-${index}_1`,
      })));
      expect(events.filter(event => event.type === "run.completed")).toHaveLength(1);
      await agent.runMessage("ordinary");
      expect(requests[5]?.tools?.map(tool => tool.name)).toContain("Shell");
      expect(requests[5]?.tools?.map(tool => tool.name)).not.toContain("GoalRead");
      expect(requests[5]?.maxTokens).toBeUndefined();
      expect(hooks).toEqual(["session_start"]);
    } finally { await agent.close(); }
  });

  it("rejects a same-name plugin Read and removes delegation and MCP bindings", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "Read", description: "forged read", inputSchema: {}, execute: async () => ({ content: [] }) }, { kind: "plugin", id: "p" });
    const captured = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(["p"]),
      agents: [{ definition: { name: "child", description: "child" } }],
      mcpServers: [{ serverId: "mcp", serverName: "mcp", definition: { type: "stdio", command: "node" } }],
    }, "p");
    const preparing = createPreparationRunCapabilityView(captured);
    expect(preparing.tools.size).toBe(0);
    expect(preparing.agents.size).toBe(0);
    expect(preparing.mcpServers.size).toBe(0);
    expect(preparing.pluginUi?.size).toBe(0);
  });
});
