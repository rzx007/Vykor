import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventInput, AgentExecutionContext, StreamMessageParams, ToolDefinition } from "@vykor/core";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import { HookExecutor } from "@vykor/hooks";
import { SkillRegistry, type SkillDefinition } from "@vykor/skills";
import { createRunCapabilityView } from "../../packages/agent-runtime/src/run-capability-view.js";
import { createVykorRuntime } from "../../packages/agent-runtime/src/default-runtime.js";
import type { ResolvedAgentCapabilities } from "../../packages/agent-runtime/src/capability-resolution.js";

export const capabilityFixtureVersion = "effective-capability-v1";
const delegation = "# Delegation And Subagents";
const background = "use BackgroundShellCreate, then follow progress with JobWait or JobRead.";
const skillsHeading = "# Available Skills";
const agentsHeading = "# Available agents";
const lifecycleTools = ["Agent", "BackgroundShellCreate", "JobWait", "JobRead", "JobSend", "JobCancel", "Skill"];
const capabilities = (enabled: boolean): ResolvedAgentCapabilities => {
  const available = { status: "available", value: {}, source: "override" } as const;
  const disabled = { status: "disabled" } as const;
  return { terminal: disabled, memory: disabled, workflowRepository: disabled, schedules: disabled,
    backgroundShell: enabled ? available : disabled, jobs: enabled ? available : disabled,
    childEnvironment: enabled ? available : disabled } as ResolvedAgentCapabilities;
};
const skill = (name: string): SkillDefinition => ({ name, description: `${name} discovery hint`,
  content: "Skill body remains loaded on demand", path: `/fixture/${name}/SKILL.md`, source: "project",
  userInvocable: true, disableModelInvocation: false });
const probe = (name: string, execute: ToolDefinition["execute"]): ToolDefinition => ({
  name, description: `${name} offline operation`, inputSchema: { type: "object", properties: { command: { type: "string" } } }, execute,
});

function execution(view: ReturnType<typeof createRunCapabilityView>, status: "approved" | "denied" = "approved", approvals: string[] = []): AgentExecutionContext {
  return { capabilityView: view, scope: { agentId: "fixture", sessionId: "fixture", inputId: "fixture", runId: "fixture", traceId: "fixture", cwd: process.cwd(), signal: new AbortController().signal },
    effects: { requestPermission: async (request: { toolName: string }) => { approvals.push(request.toolName); return { status }; } },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("No delegation authorized in fixture"); },
      sendChildInput: async () => { throw new Error("No delegation authorized in fixture"); }, interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("No delegation authorized in fixture"); } },
  };
}

describe(capabilityFixtureVersion, () => {
  const samples = [
    { name: "enabled", host: true, denied: [] as string[], ceiling: undefined, want: lifecycleTools, sections: [true, true, true, true] },
    { name: "host-disabled", host: false, denied: [], ceiling: undefined, want: ["Skill"], sections: [false, false, true, false] },
    { name: "ceiling-read", host: true, denied: [], ceiling: ["Read"], want: [], sections: [false, false, false, false] },
    { name: "denied-agent", host: true, denied: ["Agent"], ceiling: undefined, want: lifecycleTools.filter((name) => name !== "Agent"), sections: [false, true, true, false] },
    { name: "denied-skill", host: true, denied: ["Skill"], ceiling: undefined, want: lifecycleTools.filter((name) => name !== "Skill"), sections: [true, true, false, true] },
    { name: "denied-job-read", host: true, denied: ["JobRead"], ceiling: undefined, want: lifecycleTools.filter((name) => name !== "JobRead"), sections: [false, false, true, true] },
  ];
  it.each(samples.flatMap((sample) => [false, true].map((store) => ({ ...sample, store }))))("captures $name with request store=$store", async ({ host, denied, ceiling, want, store, sections }) => {
    const cwd = mkdtempSync(join(tmpdir(), "oh-capability-"));
    const requests: StreamMessageParams[] = [];
    const registry = new SkillRegistry();
    registry.register(skill("ordinary"));
    const runtime = await createVykorRuntime({ cwd, capabilities: capabilities(host), skillRegistry: registry,
      settings: { model: "scripted", permission: { mode: "default", deniedTools: denied }, sandbox: { enabled: false } },
      configuration: { hostToolCeiling: ceiling, client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } } },
      ...(store ? { requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "scripted" } }) } } : {}),
    });
    const view = createRunCapabilityView({ toolRegistry: runtime.toolRegistry,
      skills: [{ definition: skill("ordinary") }], agents: [{ definition: { name: "worker", description: "offline worker", systemPrompt: "PRIVATE worker body" } }] });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("Inspect current capabilities.", { execution: execution(view) })) { /* consume */ }
      const request = requests[0]!;
      const names = request.tools?.map((tool) => tool.name) ?? [];
      expect(names.filter((tool) => lifecycleTools.includes(tool)).sort()).toEqual([...want].sort());
      expect(request.system).not.toContain("PRIVATE worker body");
      expect([delegation, background, skillsHeading, agentsHeading].map((section) => request.system?.includes(section))).toEqual(sections);
      expect(request.system).toContain("Do not use another tool to bypass them.");
      expect(request.system).toContain("Do not repeat the same action unless new evidence");
      if (denied.includes("JobRead")) {
        for (const name of ["Agent", "BackgroundShellCreate", "Shell"]) {
          const description = request.tools!.find((tool) => tool.name === name)!.description;
          expect.soft(description).not.toContain("JobRead");
          expect.soft(description).toContain("visible job controls");
          expect.soft(description).toContain("Do not claim");
        }
      }
    } finally { await runtime.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(["approved", "denied", "policy-denied"] as const)("keeps a visible permission tool distinct from absence: %s", async (status) => {
    const cwd = mkdtempSync(join(tmpdir(), "oh-capability-permission-"));
    const requests: StreamMessageParams[] = [];
    const calls: string[] = [];
    const approvals: string[] = [];
    const operation = probe("CapabilityOperation", async () => { calls.push("executed"); return { content: [{ type: "text", text: "operation evidence=probe-7" }] }; });
    const runtime = await createVykorRuntime({ cwd, capabilities: capabilities(false),
      settings: { model: "scripted", permission: { mode: "default", ...(status === "policy-denied" ? { deniedCommands: ["blocked-operation"] } : {}) }, sandbox: { enabled: false } },
      configuration: { tools: [operation], client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        if (requests.length === 1) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "probe-7", name: operation.name, input: { command: "blocked-operation" } } };
        yield { type: "complete" as const, stopReason: requests.length === 1 ? "tool_use" as const : "end_turn" as const };
      } } },
    });
    const view = createRunCapabilityView({ toolRegistry: runtime.toolRegistry });
    try {
      const decision = await runtime.permissionChecker.checkTool(operation.name, { command: "blocked-operation" }, operation.inputSchema);
      expect(decision.action).toBe(status === "policy-denied" ? "deny" : "ask");
      for await (const _ of runtime.queryEngine.submitMessage("Perform the scoped operation.", { execution: execution(view, status === "approved" ? "approved" : "denied", approvals) })) { /* consume */ }
      expect(requests[0]!.tools?.find((tool) => tool.name === operation.name)?.inputSchema).toEqual(operation.inputSchema);
      expect(calls).toEqual(status === "approved" ? ["executed"] : []);
      expect(approvals).toEqual(status === "policy-denied" ? [] : [operation.name]);
      const result = requests[1]!.messages.find((message) => message.type === "tool_result");
      expect(result).toMatchObject(status === "approved" ? { toolUseId: "probe-7" } : { toolUseId: "probe-7", isError: true, failureKind: "permission", executionState: "not_started" });
      expect(Boolean(result?.isError)).toBe(status !== "approved");
      expect(JSON.stringify(result)).toContain(status === "approved" ? "evidence=probe-7" : "Permission denied");
    } finally { await runtime.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it("captures only the selected plugin's tools, skills and agents", async () => {
    const requests: StreamMessageParams[] = [];
    const runtime = await createVykorRuntime({ capabilities: capabilities(true),
      settings: { model: "scripted", permission: { mode: "default" }, sandbox: { enabled: false } },
      configuration: { client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } } },
    });
    for (const id of ["selected", "other"]) runtime.toolRegistry.register(probe(`${id}Operation`, async () => ({ content: [] })), { kind: "plugin", id });
    const sources = { toolRegistry: runtime.toolRegistry, pluginIds: new Set(["selected", "other"]),
      skills: ["selected", "other"].map((ownerPluginId) => ({ ownerPluginId, definition: { ...skill(`${ownerPluginId}Skill`), source: "plugin" as const } })),
      agents: ["selected", "other"].map((ownerPluginId) => ({ ownerPluginId, definition: { name: `${ownerPluginId}:review`, description: `${ownerPluginId} agent hint`, systemPrompt: "PRIVATE plugin body" } })),
    };
    try {
      for (const id of ["selected", undefined]) {
        const view = createRunCapabilityView(sources, id);
        for await (const _ of runtime.queryEngine.submitMessage("Inspect plugin scope.", { execution: execution(view) })) { /* consume */ }
      }
      expect(requests[0]!.tools?.map((tool) => tool.name)).toContain("selectedOperation");
      expect(requests[0]!.tools?.map((tool) => tool.name)).not.toContain("otherOperation");
      expect(requests[0]!.system).toContain("selectedSkill discovery hint");
      expect(requests[0]!.system).toContain("selected:review");
      expect(requests[0]!.system).not.toContain("otherSkill");
      expect(requests[0]!.system).not.toContain("other:review");
      expect(requests[1]!.tools?.map((tool) => tool.name)).not.toContain("selectedOperation");
      expect(requests[1]!.system).not.toContain("selectedSkill");
      expect(requests[1]!.system).not.toContain("selected:review");
      expect(requests.map((request) => request.system).join("\n")).not.toContain("PRIVATE plugin body");
    } finally { await runtime.close(); }
  });

  it.each([false, true])("removes conditional instructions from the tool-free final turn, store=%s", async (store) => {
    const requests: StreamMessageParams[] = [];
    const runtime = await createVykorRuntime({ capabilities: capabilities(true),
      settings: { model: "scripted", permission: { mode: "default" }, sandbox: { enabled: false } },
      configuration: { client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        yield { type: "text_delta" as const, delta: "Partial result: the work remains unverified." };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } } },
      ...(store ? { requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "scripted" } }) } } : {}),
    });
    const view = createRunCapabilityView({ toolRegistry: runtime.toolRegistry, skills: [{ definition: skill("ordinary") }],
      agents: [{ definition: { name: "worker", description: "worker hint", systemPrompt: "private body" } }] });
    try {
      const run = { ...execution(view), hardMaxTurns: 1 };
      await expect((async () => {
        for await (const _ of runtime.queryEngine.submitMessage("Report partial results.", { execution: run })) { /* consume */ }
      })()).rejects.toThrow("Exceeded maximum agentic turns (1)");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.tools).toBeUndefined();
      expect([delegation, background, skillsHeading, agentsHeading].map((section) => requests[0]!.system?.includes(section))).toEqual([false, false, false, false]);
      expect(requests[0]!.system).toContain("Stop using tools");
      expect(JSON.stringify(requests[0]!.messages)).toContain("Report partial results.");
    } finally { await runtime.close(); }
  });

  it.each([false, true])("keeps user overrides intact while hiding Agent summaries, store=%s", async (store) => {
    const requests: StreamMessageParams[] = [];
    const custom = "User override mentions Agent and asks the user a generic question.";
    const runtime = await createVykorRuntime({ capabilities: capabilities(true),
      settings: { model: "scripted", permission: { mode: "default", deniedTools: ["Agent"] }, sandbox: { enabled: false } },
      configuration: { systemPrompt: custom, client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } } },
      ...(store ? { requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "scripted", systemPrompt: custom } }) } } : {}),
    });
    const view = createRunCapabilityView({ toolRegistry: runtime.toolRegistry,
      agents: [{ definition: { name: "worker", description: "worker hint", systemPrompt: "private" } }] });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("Question", { execution: execution(view) })) { /* consume */ }
      expect(requests[0]!.system).toBe(custom);
      expect(requests[0]!.tools?.some((tool) => tool.name === "Agent")).toBe(false);
    } finally { await runtime.close(); }
  });

  it.each([false, true])("uses the runtime tools when no Run view is supplied, store=%s", async (store) => {
    const requests: StreamMessageParams[] = [];
    const registry = new SkillRegistry();
    registry.register(skill("ordinary"));
    const runtime = await createVykorRuntime({ capabilities: capabilities(true), skillRegistry: registry,
      settings: { model: "scripted", permission: { mode: "default" }, sandbox: { enabled: false } },
      configuration: { hostToolCeiling: ["Read"], client: { async *streamMessage(input) {
        requests.push({ ...input, messages: structuredClone(input.messages) });
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } } },
      ...(store ? { requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "scripted" } }) } } : {}),
    });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("Inspect")) { /* consume */ }
      expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual(["Read"]);
      expect([delegation, background, skillsHeading, agentsHeading].map((section) => requests[0]!.system?.includes(section))).toEqual([false, false, false, false]);
    } finally { await runtime.close(); }
  });

  it("builds each actual request once from its captured snapshot and final filtered tools", async () => {
    const requests: StreamMessageParams[] = [];
    const events: AgentEventInput[] = [];
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registry.register(probe("Operation", async () => { calls.push("operation"); return { content: [{ type: "text", text: "evidence=operation-7" }] }; }));
    registry.register(probe("JobRead", async () => { throw new Error("Hidden tool must not run"); }));
    let reads = 0;
    let builds = 0;
    const settings = { model: "scripted", permission: { mode: "default" as const } };
    const client = { async *streamMessage(input: StreamMessageParams) {
      requests.push({ ...input, messages: structuredClone(input.messages) });
      if (requests.length === 1) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "operation-7", name: "Operation", input: {} } };
      yield { type: "complete" as const, stopReason: requests.length === 1 ? "tool_use" as const : "end_turn" as const };
    } };
    const engine = new QueryEngine(client, registry, new PermissionChecker({ mode: "default", autoApproveTools: ["Operation"] }),
      new HookExecutor({ cwd: process.cwd(), settings }), {
        systemPromptForTools: async () => { throw new Error("Captured request factory must win"); },
        resolveRequestConfiguration: async () => {
          const revision = reads++;
          return { revision, model: "scripted", client, systemPrompt: "stale string",
            systemPromptForTools: async (tools) => { builds++; return `snapshot=${revision};visible=${tools.map((tool) => tool.name).join(",")}`; } };
        },
        trajectoryTrackerFactory: () => ({ observe: (_event, control) => { control.hiddenTools = ["JobRead"]; } }),
      });
    const run = { ...execution(createRunCapabilityView({ toolRegistry: registry })), emit: async (event: AgentEventInput) => { events.push(event); } };
    for await (const _ of engine.submitMessage("Perform one operation", { execution: run })) { /* consume */ }
    expect(requests.map((request) => request.system)).toEqual(["snapshot=0;visible=Operation,JobRead", "snapshot=2;visible=Operation"]);
    expect(requests.map((request) => request.tools?.map((tool) => tool.name))).toEqual([["Operation", "JobRead"], ["Operation"]]);
    expect(calls).toEqual(["operation"]);
    expect(builds).toBe(2);
    expect(engine.getContextUsagePromptSource().systemPrompt).toBe(requests[1]!.system);
    expect(events.flatMap((event) => event.type === "domain.event" && event.data.name === "request.configuration" ? [event.data.payload] : []))
      .toEqual([{ revision: 0, model: "scripted" }, { revision: 2, model: "scripted" }]);
  });
});
