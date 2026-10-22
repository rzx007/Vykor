import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { createInProcessChildEnvironmentProvider } from "./child-environment.js";
import { createDefaultNodeAgent } from "./default-agent.js";
import type { Settings } from "@vykor/host-config";

const settings: Settings = {
  model: "ownership-test",
  apiFormat: "openai",
  maxTurns: 1,
  permission: { mode: "full_auto" },
  memory: { enabled: false },
  sandbox: { enabled: false },
};
const capabilityOverrides = {
  terminal: false,
  jobs: false,
  backgroundShell: false,
  memory: false,
  childEnvironment: false,
  workflowRepository: false,
} as const;
const client = {
  async *streamMessage() {
    yield { type: "complete" as const, stopReason: "end_turn" };
  },
};

describe("Node execution ownership", () => {
  it("Agent eviction leaves borrowed daemon resources usable until the daemon closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vk-agent-borrowed-owner-"));
    const owner = new ExecutionRuntimeOwner();
    const supervisor = owner.getDetachedProcessSupervisor({
      cwd,
      sessionId: "session",
    });
    const stop = vi.spyOn(supervisor, "aclose");
    const agent = await createDefaultNodeAgent({
      cwd,
      sessionId: "session",
      settings,
      client,
      executionOwner: owner,
      capabilityOverrides,
      pluginsEnabled: false,
    });
    try {
      await agent.close();
      expect(stop).not.toHaveBeenCalled();
      expect(
        owner.getDetachedProcessSupervisor({ cwd, sessionId: "session" }),
      ).toBe(supervisor);
      await owner.close();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await agent.close();
      await owner.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("standalone Node assembly closes its private owner on close and on initialization failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vk-agent-private-owner-"));
    const close = vi.spyOn(ExecutionRuntimeOwner.prototype, "close");
    try {
      const agent = await createDefaultNodeAgent({
        cwd,
        settings,
        client,
        capabilityOverrides,
        pluginsEnabled: false,
      });
      await agent.close();
      expect(close).toHaveBeenCalledOnce();
      close.mockClear();
      await expect(
        createDefaultNodeAgent({
          cwd,
          client,
          capabilityOverrides,
          pluginsEnabled: false,
          settings: {
            ...settings,
            permission: { ...settings.permission, allowedTools: ["TaskWait"] },
          },
        }),
      ).rejects.toThrow(/removed lifecycle/);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

it("borrows an explicit environment across root and child without releasing it", async () => {
  const release = vi.fn(async () => {}),
    cwd = process.cwd();
  const environment = {
    info: { kind: "local", networkMode: "host", mounts: [], limitations: [] },
    workspace: { hostRoot: cwd, executionRoot: cwd },
    release,
  } as any;
  const agent = await createDefaultNodeAgent({
    cwd,
    settings,
    client,
    executionEnvironment: environment,
    capabilityOverrides: {
      ...capabilityOverrides,
      jobs: undefined,
      childEnvironment: createInProcessChildEnvironmentProvider(),
    },
    pluginsEnabled: false,
  });
  await agent.runChildForCompletedRun(
    { agent: "worker", description: "review", prompt: "review", cwd },
    { runId: "finished", inputId: "input", traceId: "trace" },
    "review",
  );
  await agent.close();
  expect(release).not.toHaveBeenCalled();
  await environment.release();
  expect(release).toHaveBeenCalledTimes(1);
});

it("releases an explicitly transferred environment once after child and root close", async () => {
  const release = vi.fn(async () => {}),
    cwd = process.cwd();
  const environment = {
    info: { kind: "local", networkMode: "host", mounts: [], limitations: [] },
    workspace: { hostRoot: cwd, executionRoot: cwd },
    release,
  } as any;
  const agent = await createDefaultNodeAgent({
    cwd,
    settings,
    client,
    executionEnvironment: environment,
    ownsExecutionEnvironment: true,
    capabilityOverrides: {
      ...capabilityOverrides,
      jobs: undefined,
      childEnvironment: createInProcessChildEnvironmentProvider(),
    },
    pluginsEnabled: false,
  });
  await agent.runChildForCompletedRun(
    { agent: "worker", description: "review", prompt: "review", cwd },
    { runId: "finished", inputId: "input", traceId: "trace" },
    "review",
  );
  expect(release).not.toHaveBeenCalled();
  await agent.close();
  await agent.close();
  expect(release).toHaveBeenCalledTimes(1);
});
