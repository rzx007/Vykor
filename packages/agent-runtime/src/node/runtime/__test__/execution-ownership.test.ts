import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { createInProcessChildEnvironmentProvider } from "../../children/child-environment.js";
import { createDefaultNodeAgent } from "../../agent/default-agent.js";
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
    executionEnvironment: async () => environment,
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

it("releases a completed system child's lease independently before closing the root lease once", async () => {
  const releases = new Map<string, number>();
  const cwd = process.cwd();
  const agent = await createDefaultNodeAgent({
    cwd,
    settings,
    client,
    executionEnvironment: async scope => {
      releases.set(scope.sessionId, 0);
      return {
        info: { kind: "local", networkMode: "host", mounts: [], limitations: [] },
        workspace: { hostRoot: scope.cwd, executionRoot: scope.cwd },
        release: async () => { releases.set(scope.sessionId, releases.get(scope.sessionId)! + 1); },
      } as any;
    },
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
  expect([...releases.values()]).toEqual([0, 1]);
  await agent.close();
  await agent.close();
  expect([...releases.values()]).toEqual([1, 1]);
});

it("passes the child's tightened sandbox policy to its environment factory", async () => {
  const sandboxEnabled: Array<boolean | undefined> = [];
  const cwd = process.cwd();
  const agent = await createDefaultNodeAgent({
    cwd, settings: { ...settings, permission: { mode: "default" }, sandbox: { enabled: true } },
    approvalMode: "full_access", client, pluginsEnabled: false,
    capabilityOverrides: { ...capabilityOverrides, jobs: undefined, childEnvironment: createInProcessChildEnvironmentProvider() },
    executionEnvironment: async scope => {
      sandboxEnabled.push(scope.settings.sandbox?.enabled);
      return {
        info: { kind: "local", networkMode: "host", mounts: [], limitations: [] },
        workspace: { hostRoot: scope.cwd, executionRoot: scope.cwd },
        release: async () => {},
      } as any;
    },
    ownsExecutionEnvironment: true,
  });
  try {
    await agent.runChildForCompletedRun(
      { agent: "worker", description: "restricted review", prompt: "review", cwd, permissionMode: "default" },
      { runId: "finished", inputId: "input", traceId: "trace" }, "review",
    );
    expect(sandboxEnabled).toEqual([false, true]);
  } finally {
    await agent.close();
  }
});

it.each([true, false])("rejects an environment bound to another workspace (owned=%s)", async ownsExecutionEnvironment => {
  let releases = 0;
  await expect(createDefaultNodeAgent({
    cwd: process.cwd(), settings, client, capabilityOverrides, pluginsEnabled: false,
    executionEnvironment: async () => ({ workspace: { hostRoot: join(process.cwd(), "other") },
      release: async () => { releases++; } }) as any,
    ownsExecutionEnvironment,
  })).rejects.toThrow(/workspace does not match session cwd/);
  expect(releases).toBe(ownsExecutionEnvironment ? 1 : 0);
});

it("rejects an empty host environment lease instead of creating a default environment", async () => {
  await expect(createDefaultNodeAgent({
    cwd: process.cwd(), settings, client, capabilityOverrides, pluginsEnabled: false,
    executionSurface: "desktop_managed",
    executionEnvironment: async () => undefined as any,
  })).rejects.toThrow(/factory returned no lease/);
});

it.each(["runtime", "integration"] as const)("releases an acquired environment exactly once when %s initialization fails", async stage => {
  let releases = 0;
  const cwd = process.cwd();
  await expect(createDefaultNodeAgent({
    cwd, settings, client, capabilityOverrides, pluginsEnabled: false,
    executionEnvironment: async () => ({
      info: { kind: "local", networkMode: "host", mounts: [], limitations: [] },
      workspace: { hostRoot: cwd, executionRoot: cwd },
      release: async () => { releases++; },
    }) as any,
    ownsExecutionEnvironment: true,
    ...(stage === "runtime" ? { hostToolCeiling: ["TaskWait"] } : {
      extensions: [{ setup: () => { throw new Error("integration failed"); } }],
    }),
  })).rejects.toThrow(stage === "runtime" ? /removed lifecycle/ : /integration failed/);
  expect(releases).toBe(1);
});
