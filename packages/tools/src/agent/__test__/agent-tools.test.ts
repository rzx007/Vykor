import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { agentTool, createAgentTool } from "../index.js";
import type { AgentChildController, AgentExecutionContext } from "@vykor/core";
import type { AgentDefinition } from "@vykor/coordinator";

type SpawnInput = Parameters<AgentChildController["spawnChildAgent"]>[0];
type SpawnResult = Awaited<ReturnType<AgentChildController["spawnChildAgent"]>>;

function createAgentContext(
  spawnImpl: (input: SpawnInput) => Promise<SpawnResult> =
    async () => ({
      id: "task_1",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
    }),
) {
  const calls: SpawnInput[] = [];
  const childIds = new Set<string>();
  const children: AgentChildController = {
    hasChildAgent: vi.fn((id: string) => childIds.has(id)),
    spawnChildAgent: vi.fn(async (input: SpawnInput) => {
      calls.push(input);
      const result = await spawnImpl(input);
      childIds.add(result.id);
      return result;
    }),
    sendChildInput: vi.fn(async () => {}),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
  };
  const agent: AgentExecutionContext = {
    scope: {
      agentId: "leader",
      sessionId: "leader-session",
      inputId: "input-1",
      runId: "run-1",
      traceId: "trace-1",
      cwd: "/work",
      signal: new AbortController().signal,
    },
    effects: { requestPermission: vi.fn(async () => ({ status: "approved" as const })) },
    children,
    emit: vi.fn(),
    takeSteeredInputs: async () => [],
    closeSteering: vi.fn(),
  };
  return { agent, children, calls };
}

describe("agentTool framework child controller", () => {
  it("uses only the run-bound agent definition and ignores model supplied capabilities", async () => {
    const { agent, calls } = createAgentContext();
    const capabilityView = {
      agents: new Map([["plugin:review", { ownerPluginId: "plugin", definition: {
        name: "plugin:review", description: "Review", systemPrompt: "Child-only instructions",
        tools: ["Read"], requiredMcpServers: ["plugin:docs"],
      } }]]), tools: new Map(), skills: new Map(), mcpServers: new Map(),
    };
    const result = await agentTool.execute({ description: "review", prompt: "inspect", subagentType: "plugin:review", capabilityView: {} }, { cwd: "/work", agent, capabilityView });
    expect(result.isError).not.toBe(true);
    expect(calls[0]).toMatchObject({ systemPrompt: "Child-only instructions", allowedTools: ["Read"], requiredMcpServers: ["plugin:docs"] });
    const denied = await agentTool.execute({ description: "d", prompt: "p", subagentType: "worker" }, { cwd: "/work", agent, capabilityView });
    expect(denied.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("declares isolate in inputSchema", () => {
    const props = (agentTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.isolate).toBeDefined();
    expect((props.isolate as { type: string }).type).toBe("boolean");
  });

  it("does not expose an execution mode selector", () => {
    const props = (agentTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.mode).toBeUndefined();
  });

  it("rejects explicit mode instead of treating it as compatibility", async () => {
    const { agent, children } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "local_agent" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Agent.mode is not supported");
    expect(children.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("requires a runtime host", async () => {
    const result = await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work" },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("No framework child manager");
  });

  it("passes isolate:true through to the framework child controller", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "do work", team: "alpha", isolate: true },
      { cwd: "/work", agent },
    );

    expect(calls.at(-1)?.isolate).toBe(true);
  });

  it("passes isolate:false when omitted", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", agent });

    expect(calls.at(-1)?.isolate).toBe(false);
  });

  it("defaults omitted subagentType to the built-in worker definition", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute({ description: "d", prompt: "implement" }, { cwd: "/work", agent });

    expect(calls.at(-1)).toMatchObject({
      agent: "worker",
      allowedTools: ["*"],
      disallowedTools: [
        "Agent",
        "JobSend",
        "JobCancel",
        "JobWait",
        "Workflow",
        "TeamCreate",
        "TeamDelete",
      ],
    });
  });

  it("resolves builtin < user < scoped plugin precedence inside each Agent tool", async () => {
    const configDir = mkdtempSync(
      join(tmpdir(), "vk-agent-tool-definitions-"),
    );
    const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;
    mkdirSync(join(configDir, "agents"), { recursive: true });
    writeFileSync(
      join(configDir, "agents", "worker.md"),
      "---\nmodel: user-model\n---\nUser worker prompt.\n",
    );
    const pluginWorker: AgentDefinition = {
      name: "worker",
      description: "Plugin worker",
      model: "plugin-model",
      systemPrompt: "Plugin worker prompt.",
      source: "plugin",
    };

    try {
      const userOnlyTool = createAgentTool({ agentDefinitions: [] });
      const pluginTool = createAgentTool({ agentDefinitions: [pluginWorker] });
      const userScope = createAgentContext();
      const pluginScope = createAgentContext();

      await userOnlyTool.execute(
        { description: "d", prompt: "implement" },
        { cwd: "/work", agent: userScope.agent },
      );
      await pluginTool.execute(
        { description: "d", prompt: "implement" },
        { cwd: "/work", agent: pluginScope.agent },
      );

      expect(userScope.calls.at(-1)).toMatchObject({
        agent: "worker",
        model: "user-model",
        systemPrompt: "User worker prompt.",
      });
      expect(pluginScope.calls.at(-1)).toMatchObject({
        agent: "worker",
        model: "plugin-model",
        systemPrompt: "Plugin worker prompt.",
      });
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.VYKOR_CONFIG_DIR;
      } else {
        process.env.VYKOR_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("passes a generated child session id to the host", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work", sessionId: "leader-session", agent },
    );

    expect(calls.at(-1)?.sessionId).toEqual(expect.any(String));
    expect(calls.at(-1)?.cwd).toBe("/work");
  });

  it("includes worktree branch and path in the returned text", async () => {
    const { agent } = createAgentContext(async () => ({
      id: "task_3",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
      worktree: { path: "/wt/alpha-build-xyz", branch: "worktree-alpha-build-xyz" },
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", agent },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("worktree-alpha-build-xyz");
    expect(text).toContain("/wt/alpha-build-xyz");
  });

  it("returns the worker identity through the Jobs protocol", async () => {
    const { agent } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "do work" },
      { cwd: "/work", agent },
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      kind: "job",
      action: "created",
      jobId: "task_1",
      jobKind: "agent",
      sessionId: "child-1",
    });
  });

  it("passes permissionMode through to the framework child controller", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "full_auto" },
      { cwd: "/work", agent },
    );

    expect(calls.at(-1)?.permissionMode).toBe("full_auto");
  });

  it("leaves permissionMode undefined when omitted", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", agent });

    expect(calls.at(-1)?.permissionMode).toBeUndefined();
  });

  it("rejects an invalid permissionMode with isError instead of spawning", async () => {
    const { agent, children } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "yolo" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBe(true);
    expect(children.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("includes notice in the returned text when present", async () => {
    const { agent } = createAgentContext(async () => ({
      id: "task_4",
      sessionId: "child-4",
      result: Promise.resolve({ status: "completed", output: "done" }),
      notice: "isolate requested but unavailable; running in shared cwd",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", agent },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("isolate requested but unavailable");
  });

});
