import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, Settings, StreamMessageParams, ToolDefinition } from "@vykor/core";
import { skillTool } from "../../tools/src/meta/skill.js";
import { createAgentKernel, createBasicAgentKernelRuntime } from "./kernel.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import { unavailableCapability } from "./capability-resolution.js";
import { createVykorRuntime } from "./default-runtime.js";

const settings: Settings = {
  model: "scripted-client", apiFormat: "anthropic", maxTurns: 8,
  permission: { mode: "default" }, sandbox: { enabled: false },
};
const candidates = ["knowledge-work", "office-work"].map(pluginId => ({
  pluginId, displayName: pluginId, description: `${pluginId} capability summary`,
  version: "1", behaviorDigest: `${pluginId}-digest`,
}));
const skills = candidates.map(({ pluginId }) => ({
  ownerPluginId: pluginId, path: `D:/approved/${pluginId}/SKILL.md`,
  definition: {
    name: `${pluginId}/actual`, description: `${pluginId} skill summary`,
    content: `PRIVATE_SKILL_BODY_${pluginId}`, path: `D:/approved/${pluginId}/SKILL.md`,
    source: "plugin" as const, userInvocable: true, disableModelInvocation: false,
  },
}));

async function fixture(script: Array<{ name: string; input: Record<string, unknown> }>, deferred = false) {
  const requests: StreamMessageParams[] = [];
  const events: AgentEvent[] = [];
  const files = new Map<string, string>();
  const used: string[] = [];
  const validate = vi.fn(async () => {});
  let makeView!: (scope?: string | readonly string[]) => ReturnType<typeof createRunCapabilityView>;
  const define = (name: string, owner: string, execute: ToolDefinition["execute"]): ToolDefinition => ({
    name, description: `${owner} operation`, inputSchema: { type: "object",
      ...(deferred ? { description: "SCHEMA_ONLY_SENTINEL ".repeat(1800) } : {}),
    }, execute,
  });
  const agent = await createAgentKernel({
    settings, cwd: "D:/workspace", sessionId: "handoff-test",
    capabilities: {
      terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"),
      jobs: unavailableCapability("test"), memory: unavailableCapability("test"),
      childEnvironment: unavailableCapability("test"), workflowRepository: unavailableCapability("test"),
      schedules: unavailableCapability("test"),
    },
    effects: { requestPermission: async () => ({ status: "approved" }) },
    onEvent: event => { events.push(event); },
    createRuntime: async context => {
      const client = {
        async *streamMessage(params: StreamMessageParams) {
          const step = script[requests.length];
          // QueryEngine later appends results to its message array; preserve what this request actually saw.
          requests.push({ ...params, messages: structuredClone(params.messages) });
          if (step) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `step-${requests.length}`, ...step } };
          else yield { type: "text_delta" as const, delta: "done" };
          yield { type: "complete" as const, stopReason: step ? "tool_use" as const : "end_turn" as const };
        },
      };
      const prepared = deferred ? { runtime: await createVykorRuntime({
        settings: context.settings, cwd: context.cwd, sessionId: context.sessionId,
        capabilities: context.capabilities, configuration: { ...context.configuration, client },
      }) } : createBasicAgentKernelRuntime({ settings: context.settings, cwd: context.cwd, tools: [skillTool], client });
      prepared.runtime.toolRegistry.register(define("KnowledgeWrite", "knowledge-work", async () => {
        used.push("knowledge-work");
        files.set("report.md", "Internal assumptions S1-S4; 300 min/week; target savings 81 min/week.");
        return { content: [{ type: "text", text: "report.md" }] };
      }), { kind: "plugin", id: "knowledge-work" });
      prepared.runtime.toolRegistry.register(define("OfficeMakeSlides", "office-work", async input => {
        used.push("office-work");
        const report = files.get(String(input.report));
        if (!report) return { content: [{ type: "text", text: "Report is missing" }], isError: true };
        files.set("presentation.pptx", report);
        return { content: [{ type: "text", text: "presentation.pptx" }] };
      }), { kind: "plugin", id: "office-work" });
      makeView = scope => createRunCapabilityView({
        toolRegistry: prepared.runtime.toolRegistry, pluginIds: new Set(candidates.map(item => item.pluginId)), skills,
      }, scope);
      prepared.runtime.createRunCapabilityView = makeView;
      return { ...prepared, pluginSelection: { candidates, validate } };
    },
  });
  return { agent, requests, events, files, used, validate, makeView };
}

describe("multi-plugin execution through the real Agent and query engine", () => {
  it("discovers and calls both plugins through the default runtime without changing the Run view", async () => {
    const f = await fixture([
      { name: "Skill", input: { name: "knowledge-work/actual", path: skills[0]!.path } },
      { name: "ToolSearch", input: { query: "KnowledgeWrite", limit: 1 } },
      { name: "KnowledgeWrite", input: {} },
      { name: "Skill", input: { name: "office-work/actual", path: skills[1]!.path } },
      { name: "ToolSearch", input: { query: "OfficeMakeSlides", limit: 1 } },
      { name: "OfficeMakeSlides", input: { report: "report.md" } },
    ], true);
    try {
      const view = f.makeView(["knowledge-work", "office-work"]);
      expect((await f.agent.runMessage("report then slides", { capabilityView: view })).status).toBe("completed");
      expect(f.used).toEqual(["knowledge-work", "office-work"]);
      expect(f.files.get("presentation.pptx")).toBe(f.files.get("report.md"));
      expect(f.requests).toHaveLength(7);
      expect(JSON.stringify(f.requests[0])).not.toContain("SCHEMA_ONLY_SENTINEL");
      expect(JSON.stringify(f.requests[0])).not.toContain("PRIVATE_SKILL_BODY_");
      expect(f.requests[2]!.tools?.map(t => t.name)).toContain("KnowledgeWrite");
      expect(f.requests[2]!.tools?.map(t => t.name)).not.toContain("OfficeMakeSlides");
      expect(f.requests[5]!.tools?.map(t => t.name)).toEqual(expect.arrayContaining(["KnowledgeWrite", "OfficeMakeSlides"]));
      expect([...view.pluginIds!]).toEqual(["knowledge-work", "office-work"]);
      expect(f.events.filter(event => event.type === "tool.completed").every(event => !event.data.result.isError)).toBe(true);
      expect(f.events.some(event => event.type === "model.attempt.started" && event.data.purpose === "plugin_selection")).toBe(false);
    } finally { await f.agent.close(); }
  });

  it("does not discover a foreign tool or Skill through an explicitly limited Run", async () => {
    const f = await fixture([
      { name: "ToolSearch", input: { query: "OfficeMakeSlides" } },
      { name: "OfficeMakeSlides", input: {} },
      { name: "Skill", input: { name: "office-work/actual", path: skills[1]!.path } },
      { name: "ToolSearch", input: { query: "KnowledgeWrite", limit: 1 } },
      { name: "KnowledgeWrite", input: {} },
    ], true);
    try {
      await f.agent.runMessage("knowledge only", { capabilityView: f.makeView("knowledge-work") });
      expect(f.used).toEqual(["knowledge-work"]);
      expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_SKILL_BODY_office-work");
      expect(f.requests.flatMap(r => r.tools?.map(t => t.name) ?? [])).not.toContain("OfficeMakeSlides");
      expect(f.requests[0]!.system).not.toContain("office-work capability summary");
      const completed = f.events.filter(event => event.type === "tool.completed");
      expect(JSON.stringify(completed[0])).toContain("no matches");
      expect(completed[1]).toMatchObject({ data: { result: { isError: true, executionState: "not_started" } } });
      expect(completed.at(-1)).toMatchObject({ data: { result: { executionState: "completed" } } });
    } finally { await f.agent.close(); }
  });

  it("uses knowledge then office in one Run, loading each actual Skill on demand without a selector request", async () => {
    const f = await fixture([
      { name: "Skill", input: { name: "knowledge-work/actual", path: skills[0]!.path } },
      { name: "KnowledgeWrite", input: {} },
      { name: "Skill", input: { name: "office-work/actual", path: skills[1]!.path } },
      { name: "OfficeMakeSlides", input: { report: "report.md" } },
    ]);
    try {
      expect((await f.agent.runMessage("Use knowledge-work then office-work")).status).toBe("completed");
      expect(f.used).toEqual(["knowledge-work", "office-work"]);
      expect(f.files.get("presentation.pptx")).toBe(f.files.get("report.md"));
      expect(f.requests).toHaveLength(5);
      expect(f.requests[0]!.system).toContain("knowledge-work capability summary");
      expect(f.requests[0]!.system).toContain("office-work capability summary");
      expect(JSON.stringify(f.requests[0])).not.toContain("PRIVATE_SKILL_BODY_");
      expect(JSON.stringify(f.requests[1]!.messages)).toContain("PRIVATE_SKILL_BODY_knowledge-work");
      expect(JSON.stringify(f.requests[1]!.messages)).not.toContain("PRIVATE_SKILL_BODY_office-work");
      expect(JSON.stringify(f.requests[3]!.messages)).toContain("PRIVATE_SKILL_BODY_office-work");
      expect(f.events.some(event => event.type === "model.attempt.started" && event.data.purpose === "plugin_selection")).toBe(false);
      expect(f.events.filter(event => event.type === "tool.completed").every(event => !event.data.result.isError)).toBe(true);
    } finally { await f.agent.close(); }
  });

  it("keeps an explicit knowledge-only view even when the client tries an office Skill and tool", async () => {
    const f = await fixture([
      { name: "Skill", input: { name: "office-work/actual", path: skills[1]!.path } },
      { name: "OfficeMakeSlides", input: { report: "report.md" } },
    ]);
    try {
      await f.agent.runMessage("Try office", { capabilityView: f.makeView("knowledge-work") });
      expect(f.used).toEqual([]);
      expect(f.requests[0]!.tools?.map(tool => tool.name)).not.toContain("OfficeMakeSlides");
      expect(f.requests[0]!.system).not.toContain("office-work capability summary");
      expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_SKILL_BODY_office-work");
      const completed = f.events.filter(event => event.type === "tool.completed");
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(completed.every(event => event.data.result.isError)).toBe(true);
    } finally { await f.agent.close(); }
  });
});
