import { describe, expect, it, vi } from "vitest";

import type { Settings } from "@vykor/core";
import { createRunCapabilityView } from "./run-capability-view.js";

import {
  createAgentKernel,
  createBasicAgentKernelRuntime,
} from "./kernel.js";
import { createInProcessChildEnvironmentProvider } from "./child-environment.js";
import {
  unavailableCapability,
  type ResolvedAgentCapabilities,
} from "./capability-resolution.js";

const settings: Settings = {
  model: "kernel-test-model",
  apiFormat: "anthropic",
  maxTurns: 5,
  permission: { mode: "default" },
  sandbox: { enabled: false },
};

describe("createAgentKernel", () => {
  it("keeps a trusted explicit plugin view usable when the Kernel host does not supply a catalog", async () => {
    let invoked = 0;
    let requests = 0;
    const agent = await createAgentKernel({ settings, cwd: "D:/explicit-workspace", capabilities: unavailableCapabilities(),
      effects: { requestPermission: async () => ({ status: "approved" }) }, createRuntime: async context => {
        const prepared = createBasicAgentKernelRuntime({ settings: context.settings, cwd: context.cwd, client: {
          async *streamMessage() {
            requests++;
            if (requests === 1) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "plugin", name: "Trusted", input: {} } };
            yield { type: "complete" as const, stopReason: requests === 1 ? "tool_use" as const : "end_turn" as const };
          },
        } });
        prepared.runtime.toolRegistry.register({ name: "Trusted", description: "host-owned", inputSchema: { type: "object" },
          execute: async () => { invoked++; return { content: [] }; } }, { kind: "plugin", id: "P" });
        prepared.runtime.createRunCapabilityView = scope => createRunCapabilityView({ toolRegistry: prepared.runtime.toolRegistry, pluginIds: new Set(["P"]) }, scope);
        return prepared;
      } });
    try {
      await agent.runMessage("use trusted capability", { capabilityView: agent.createRunCapabilityView("P") });
      expect(invoked).toBe(1);
      expect(requests).toBe(2);
    } finally { await agent.close(); }
  });
  it.each(["disabled", "upgraded"])("rejects a newly spawned child before its model executes after its inherited plugin is %s", async change => {
    let rootRequests = 0;
    let childRequests = 0;
    let childFailure = "";
    const initial = { pluginId: "P", displayName: "P", description: "P", version: "1", behaviorDigest: "digest-1" };
    const capabilities = unavailableCapabilities();
    capabilities.childEnvironment = { status: "available", source: "override", value: createInProcessChildEnvironmentProvider() };
    const agent = await createAgentKernel({ settings, cwd: "D:/explicit-workspace", capabilities,
      effects: { requestPermission: async () => ({ status: "approved" }) }, createRuntime: async context => {
        const isChild = Boolean(context.identity);
        const prepared = createBasicAgentKernelRuntime({ settings: context.settings, cwd: context.cwd, client: {
          async *streamMessage() {
            if (isChild) { childRequests++; yield { type: "text_delta" as const, delta: "child executed" }; }
            else if (++rootRequests === 1) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "delegate", name: "Delegate", input: {} } };
            yield { type: "complete" as const, stopReason: !isChild && rootRequests === 1 ? "tool_use" as const : "end_turn" as const };
          },
        }, tools: [{ name: "Delegate", description: "spawn child", inputSchema: { type: "object" }, execute: async (_input, toolContext) => {
          try {
            const child = await toolContext.agent!.children!.spawnChildAgent({ description: "work", prompt: "work", agent: "worker", cwd: context.cwd });
            childFailure = (await child.result).output;
          } catch (error) { childFailure = String(error); }
          return { content: [{ type: "text", text: childFailure }] };
        } }] });
        prepared.runtime.createRunCapabilityView = scope => createRunCapabilityView({ toolRegistry: prepared.runtime.toolRegistry, pluginIds: new Set(["P"]) }, scope);
        return { ...prepared, pluginSelection: { candidates: !isChild ? [initial] : change === "disabled" ? [] : [{ ...initial, version: "2", behaviorDigest: "digest-2" }], validate: async () => {} } };
      } });
    try {
      await agent.runMessage("delegate");
      expect(childRequests).toBe(0);
      expect(childFailure).toMatch(/changed|available|owner/);
    } finally { await agent.close(); }
  });
  it("exposes and validates only the host catalog without a selection model request", async () => {
    let requests = 0;
    const validate = vi.fn(async () => {});
    const agent = await createAgentKernel({
      settings, cwd: "D:/explicit-workspace", sessionId: "kernel-selection",
      capabilities: unavailableCapabilities(), effects: { requestPermission: async () => ({ status: "denied" }) },
      createRuntime: async context => ({
        ...createBasicAgentKernelRuntime({ settings: context.settings, cwd: context.cwd, client: {
          async *streamMessage() {
            requests++;
            yield { type: "text_delta" as const, delta: '{"pluginId":"office"}' };
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        } }),
        pluginSelection: { candidates: [{ pluginId: "office", displayName: "Office", description: "slides", version: "1", behaviorDigest: "digest" }], validate },
      }),
    });
    try {
      const candidates = agent.getPluginCandidates();
      expect(candidates).toEqual([{ pluginId: "office", displayName: "Office", description: "slides", version: "1", behaviorDigest: "digest" }]);
      await agent.validatePluginScope(candidates, new AbortController().signal);
      expect(requests).toBe(0);
      expect(validate).toHaveBeenCalledWith(candidates[0]);
    } finally {
      await agent.close();
    }
  });

  it("只使用调用方给出的 runtime 和能力，不安装本地 fallback", async () => {
    const effects = {
      requestPermission: vi.fn(async () => ({ status: "approved" as const })),
    };
    const capabilities = unavailableCapabilities();
    const createRuntime = vi.fn(async (context) =>
      createBasicAgentKernelRuntime({
        settings: context.settings,
        cwd: context.cwd,
        sessionId: context.sessionId,
        client: {
          async *streamMessage() {
            yield { type: "text_delta" as const, delta: "kernel reply" };
            yield {
              type: "complete" as const,
              stopReason: "end_turn" as const,
            };
          },
        },
      }),
    );
    const agent = await createAgentKernel({
      settings,
      cwd: "D:/explicit-workspace",
      sessionId: "kernel-session",
      capabilities,
      effects,
      createRuntime,
    });

    try {
      await expect(agent.runMessage("hello")).resolves.toMatchObject({
        status: "completed",
        output: "kernel reply",
      });
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "D:/explicit-workspace",
          sessionId: "kernel-session",
          settings,
          capabilities,
        }),
      );
      expect(agent.getCapabilities()).toEqual(
        expect.objectContaining({
          terminal: { status: "unavailable", reason: "Kernel host did not provide terminal" },
          jobs: { status: "unavailable", reason: "Kernel host did not provide jobs" },
        }),
      );
      expect(agent.inspect().tools.map((tool) => tool.name)).not.toContain(
        "JobList",
      );
    } finally {
      await agent.close();
    }
  });

  it("Kernel 默认 child 环境不读取 Git，也不创建 worktree", async () => {
    const environment = createInProcessChildEnvironmentProvider();
    const lease = await environment.acquire(
      {
        description: "isolated request",
        prompt: "work",
        cwd: "D:/plain-folder",
        isolate: true,
      },
      "child-1",
    );

    expect(lease).toMatchObject({ cwd: "D:/plain-folder" });
    expect(lease.worktree).toBeUndefined();
    await expect(
      lease.release({ status: "completed", output: "done" }),
    ).resolves.toBeUndefined();
  });
});

function unavailableCapabilities(): ResolvedAgentCapabilities {
  return {
    terminal: unavailableCapability("Kernel host did not provide terminal"),
    backgroundShell: unavailableCapability("Kernel host did not provide background shell"),
    jobs: unavailableCapability("Kernel host did not provide jobs"),
    memory: unavailableCapability("Kernel host did not provide memory"),
    childEnvironment: unavailableCapability("Kernel host did not provide child environment"),
    workflowRepository: unavailableCapability("Kernel host did not provide workflow repository"),
    schedules: unavailableCapability("Kernel host did not provide schedules"),
  };
}
