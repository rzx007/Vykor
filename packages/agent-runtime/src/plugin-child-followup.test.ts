import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RuntimeBundle, Settings, StreamingMessageClient, ToolDefinition } from "@vykor/core";
import { CompositeAgentJobHost } from "@vykor/jobs";
import { getDetachedProcessSupervisor, resetExecutionRuntimes } from "@vykor/services/executions";
import { LocalAgentJobHost } from "../../tools/src/job/local-job-host.js";
import { jobSendTool } from "../../tools/src/job/job-tools.js";
import { createAgentKernel, createBasicAgentKernelRuntime } from "./kernel.js";
import { createInProcessChildEnvironmentProvider } from "./child-environment.js";
import { unavailableCapability } from "./capability-resolution.js";
import { createRunCapabilityView } from "./run-capability-view.js";

it("checks the current Run's plugin through real JobSend, composite host and an idle Child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vk-plugin-child-followup-"));
  const sessionId = "root-followup";
  const pluginCalls: string[] = [];
  let childId = "";
  let rootRuntime!: RuntimeBundle;
  const settings: Settings = { model: "test", apiFormat: "anthropic", maxTurns: 3, permission: { mode: "default" } };
  const pluginTool: ToolDefinition = {
    name: "PluginWork", description: "selected plugin work", inputSchema: { type: "object" },
    execute: async (_input, context) => {
      pluginCalls.push(context.capabilityView!.pluginId!);
      return { content: [{ type: "text", text: "plugin work completed" }] };
    },
  };
  const spawnTool: ToolDefinition = {
    name: "Spawn", description: "spawn selected child", inputSchema: { type: "object" },
    execute: async (_input, context) => {
      const child = await context.agent!.children.spawnChildAgent({
        description: "plugin child", prompt: "work", agent: "worker", cwd,
      });
      childId = child.id;
      return { content: [{ type: "text", text: (await child.result).output }] };
    },
  };
  const client = (child: boolean): StreamingMessageClient => ({
    async *streamMessage(request) {
      const latest = request.messages.at(-1)!;
      if (latest.type === "user") {
        const name = child ? "PluginWork" : latest.content === "spawn" ? "Spawn" : "JobSend";
        yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: `call-${request.messages.length}`, name,
          // A model-provided pluginId must not become host authorization.
          input: name === "JobSend" ? { jobId: childId, data: "continue", pluginId: "P" } : {},
        } };
        yield { type: "complete", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: latest.type === "tool_result"
          ? latest.content.map((block) => block.type === "text" ? block.text : "").join("") : "done" };
        yield { type: "complete", stopReason: "end_turn" };
      }
    },
  });
  const agent = await createAgentKernel({
    cwd, sessionId, settings, effects: { requestPermission: async () => ({ status: "approved" }) },
    capabilities: {
      terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"),
      jobs: unavailableCapability("test"), memory: unavailableCapability("test"),
      workflowRepository: unavailableCapability("test"), schedules: unavailableCapability("test"),
      childEnvironment: { status: "available", source: "override", value: createInProcessChildEnvironmentProvider() },
    },
    createRuntime: async (context) => {
      const prepared = createBasicAgentKernelRuntime({
        cwd: context.cwd, sessionId: context.sessionId, settings, client: client(Boolean(context.identity)),
        tools: context.identity ? [] : [spawnTool, jobSendTool],
      });
      prepared.runtime.toolRegistry.register(pluginTool, { kind: "plugin", id: "P" });
      prepared.runtime.createRunCapabilityView = (pluginId) => createRunCapabilityView({
        toolRegistry: prepared.runtime.toolRegistry, pluginIds: new Set(["P", "Q"]),
      }, pluginId);
      if (!context.identity) rootRuntime = prepared.runtime;
      return prepared;
    },
  });
  try {
    rootRuntime.queryEngine.setJobs(new CompositeAgentJobHost([new LocalAgentJobHost({
      cwd, sessionId, childManager: agent.children,
    })]));
    await agent.runMessage("spawn", { capabilityView: agent.createRunCapabilityView("P") });
    expect(pluginCalls).toEqual(["P"]);
    expect(agent.children.get(childId)!.state).toBe("idle");
    for (const pluginId of [undefined, "Q"]) {
      const result = await agent.runMessage("follow up", { capabilityView: agent.createRunCapabilityView(pluginId) });
      expect(result.output).toContain("not authorized for this Run");
      expect(pluginCalls).toEqual(["P"]);
    }
    const accepted = await agent.runMessage("follow up", { capabilityView: agent.createRunCapabilityView("P") });
    expect(accepted.output).toContain('"action":"send"');
    await agent.children.get(childId)!.result;
    expect(pluginCalls).toEqual(["P", "P"]);
  } finally {
    await agent.close();
    await getDetachedProcessSupervisor({ cwd, sessionId }).aclose();
    resetExecutionRuntimes({ cwd, sessionId });
    rmSync(cwd, { recursive: true, force: true });
  }
});
