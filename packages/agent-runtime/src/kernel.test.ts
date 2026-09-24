import { describe, expect, it, vi } from "vitest";

import type { Settings } from "@vykor/core";

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
