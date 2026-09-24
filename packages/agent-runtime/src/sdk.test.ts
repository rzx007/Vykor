import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentEvent,
  Settings,
  StreamingMessageClient,
} from "@vykor/core";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  FileWorkflowRunRepository,
} from "@vykor/coordinator";
import { describe, expect, it, vi } from "vitest";

import { createDefaultNodeAgent } from "./index.js";

async function withTemporaryAgent<T extends { close(): Promise<void> }, R>(
  prefix: string,
  createAgent: (cwd: string) => Promise<T>,
  run: (agent: T, cwd: string) => Promise<R>,
): Promise<R> {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  let agent: T | undefined;
  try {
    agent = await createAgent(cwd);
    return await run(agent, cwd);
  } finally {
    try {
      await agent?.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

const nodePtySupportedPlatforms = new Set<NodeJS.Platform>([
  "win32",
  "linux",
  "darwin",
]);
const realPtyIt = nodePtySupportedPlatforms.has(process.platform) ? it : it.skip;

describe("programmatic agent SDK", () => {
  it("removes the real-Terminal fixture directory when Agent initialization fails", async () => {
    let cwd: string | undefined;

    await expect(
      withTemporaryAgent(
        "vykor-sdk-init-failure-",
        async (temporaryCwd) => {
          cwd = temporaryCwd;
          throw new Error("initialization failed");
        },
        async () => undefined,
      ),
    ).rejects.toThrow("initialization failed");

    expect(cwd).toBeDefined();
    expect(existsSync(cwd!)).toBe(false);
  });

  it("removes the real-Terminal fixture directory when Agent close fails", async () => {
    let cwd: string | undefined;

    await expect(
      withTemporaryAgent(
        "vykor-sdk-close-failure-",
        async (temporaryCwd) => {
          cwd = temporaryCwd;
          return {
            close: vi.fn(async () => {
              throw new Error("close failed");
            }),
          } as any;
        },
        async () => undefined,
      ),
    ).rejects.toThrow("close failed");

    expect(cwd).toBeDefined();
    expect(existsSync(cwd!)).toBe(false);
  });

  realPtyIt("runs a real Node REPL through Terminal and the shared Jobs control plane", async () => {
    let waitPayload: Record<string, any> | undefined;
    let readPayload: Record<string, any> | undefined;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (!hasToolResult(params.messages, "real-terminal-open")) {
          yield toolUse("real-terminal-open", "TerminalOpen", {
            name: "node-repl",
            shell: process.execPath,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        const jobId = terminalIdFromResult(params.messages, "real-terminal-open");
        if (!hasToolResult(params.messages, "real-terminal-send")) {
          yield toolUse("real-terminal-send", "JobSend", {
            jobId,
            data: "process.stdout.write('terminal-ok'); process.exit(0)\n",
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "real-terminal-wait")) {
          yield toolUse("real-terminal-wait", "JobWait", {
            jobIds: [jobId],
            timeoutSeconds: 5,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "real-terminal-read")) {
          waitPayload = toolResultPayload(params.messages, "real-terminal-wait");
          yield toolUse("real-terminal-read", "JobRead", { jobId });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        readPayload = toolResultPayload(params.messages, "real-terminal-read");
        yield { type: "text_delta" as const, delta: "real terminal complete" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    await withTemporaryAgent(
      "vykor-sdk-real-terminal-",
      (cwd) => createDefaultNodeAgent({
        cwd,
        sessionId: "real-terminal-session",
        client,
        settings: { ...testSettings(), maxTurns: 8 },
      }),
      async (agent) => {
        await expect(agent.runMessage("exercise the real terminal")).resolves.toMatchObject({
          output: "real terminal complete",
        });
        expect(waitPayload).toMatchObject({
          results: [{ timedOut: false, snapshot: { status: "completed" } }],
        });
        expect(JSON.stringify(waitPayload)).toContain("terminal-ok");
        expect(readPayload).toMatchObject({
          snapshot: { status: "completed" },
        });
        expect(JSON.stringify(readPayload)).toContain("terminal-ok");
      },
    );
  }, 15_000);

  realPtyIt("sends interactive stdin to a real Node REPL before closing it", async () => {
    let runningWaitPayload: Record<string, any> | undefined;
    let readPayload: Record<string, any> | undefined;
    let finishedWaitPayload: Record<string, any> | undefined;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (!hasToolResult(params.messages, "stdin-terminal-open")) {
          yield toolUse("stdin-terminal-open", "TerminalOpen", { shell: process.execPath });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        const jobId = terminalIdFromResult(params.messages, "stdin-terminal-open");
        if (!hasToolResult(params.messages, "stdin-terminal-warmup")) {
          yield toolUse("stdin-terminal-warmup", "JobWait", {
            jobIds: [jobId],
            timeoutSeconds: 2,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "stdin-terminal-send")) {
          yield toolUse("stdin-terminal-send", "JobSend", {
            jobId,
            data: "process.stdout.write('stdin-echo:' + 'hello')\n",
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "stdin-terminal-running-wait")) {
          yield toolUse("stdin-terminal-running-wait", "JobWait", {
            jobIds: [jobId],
            timeoutSeconds: 0.25,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "stdin-terminal-read")) {
          runningWaitPayload = toolResultPayload(params.messages, "stdin-terminal-running-wait");
          yield toolUse("stdin-terminal-read", "JobRead", { jobId });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "stdin-terminal-exit")) {
          readPayload = toolResultPayload(params.messages, "stdin-terminal-read");
          yield toolUse("stdin-terminal-exit", "JobSend", {
            jobId,
            data: "process.exit(0)\n",
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "stdin-terminal-finished-wait")) {
          yield toolUse("stdin-terminal-finished-wait", "JobWait", {
            jobIds: [jobId],
            timeoutSeconds: 5,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        finishedWaitPayload = toolResultPayload(params.messages, "stdin-terminal-finished-wait");
        yield { type: "text_delta" as const, delta: "interactive terminal complete" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    await withTemporaryAgent(
      "vykor-sdk-real-stdin-",
      (cwd) => createDefaultNodeAgent({
        cwd,
        sessionId: "stdin-terminal-session",
        client,
        settings: { ...testSettings(), maxTurns: 10 },
      }),
      async (agent) => {
        await expect(agent.runMessage("exercise interactive stdin")).resolves.toMatchObject({
          output: "interactive terminal complete",
        });
        expect(runningWaitPayload).toMatchObject({
          results: [{ timedOut: true, snapshot: { status: "running" } }],
        });
        expect(JSON.stringify(readPayload)).toContain("stdin-echo:hello");
        expect(finishedWaitPayload).toMatchObject({
          results: [{ timedOut: false, snapshot: { status: "completed" } }],
        });
      },
    );
  }, 15_000);

  realPtyIt("cancels a real Node REPL as a killed Terminal Job", async () => {
    let cancelPayload: Record<string, any> | undefined;
    let waitPayload: Record<string, any> | undefined;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (!hasToolResult(params.messages, "cancel-terminal-open")) {
          yield toolUse("cancel-terminal-open", "TerminalOpen", { shell: process.execPath });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        const jobId = terminalIdFromResult(params.messages, "cancel-terminal-open");
        if (!hasToolResult(params.messages, "cancel-terminal-cancel")) {
          yield toolUse("cancel-terminal-cancel", "JobCancel", {
            jobId,
            reason: "integration test complete",
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        if (!hasToolResult(params.messages, "cancel-terminal-wait")) {
          cancelPayload = toolResultPayload(params.messages, "cancel-terminal-cancel");
          yield toolUse("cancel-terminal-wait", "JobWait", {
            jobIds: [jobId],
            timeoutSeconds: 5,
          });
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        waitPayload = toolResultPayload(params.messages, "cancel-terminal-wait");
        yield { type: "text_delta" as const, delta: "cancelled terminal complete" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    await withTemporaryAgent(
      "vykor-sdk-real-cancel-",
      (cwd) => createDefaultNodeAgent({
        cwd,
        sessionId: "cancel-terminal-session",
        client,
        settings: { ...testSettings(), maxTurns: 7 },
      }),
      async (agent) => {
        await expect(agent.runMessage("cancel the real terminal")).resolves.toMatchObject({
          output: "cancelled terminal complete",
        });
        expect(cancelPayload).toMatchObject({
          snapshot: { status: "stopping", capabilities: { send: false, cancel: false } },
        });
        expect(waitPayload).toMatchObject({
          results: [{ timedOut: false, snapshot: { status: "killed" } }],
        });
      },
    );
  }, 15_000);

  it("installs the complete standalone Node capability set without a Host", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-default-capabilities-"));
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: testSettingsWithDefaultMemory(),
    });

    try {
      expect(agent.getCapabilities()).toMatchObject({
        terminal: { status: "available", source: "default" },
        backgroundShell: { status: "available", source: "default" },
        jobs: { status: "available", source: "default" },
        memory: { status: "available", source: "default" },
        workflowRepository: { status: "available", source: "default" },
        schedules: { status: "unavailable" },
      });
      expect(agent.inspect().tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["TerminalOpen", "JobList"]),
      );
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates managed memory by default without exposing managed paths to the model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-default-memory-"));
    const requests: Array<Parameters<StreamingMessageClient["streamMessage"]>[0]> = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requests.push(params);
        yield { type: "text_delta" as const, delta: "memory available" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      client,
      settings: testSettingsWithDefaultMemory(),
    });

    try {
      expect(agent.getCapabilities().memory).toEqual({
        status: "available",
        source: "default",
      });
      expect(agent.inspect().tools.map((tool) => tool.name)).toContain("Remember");

      await expect(agent.runMessage("use the managed memory tools")).resolves.toMatchObject({
        output: "memory available",
      });
      const rememberTool = requests[0]?.tools?.find((tool) => tool.name === "Remember");
      const serializedTool = JSON.stringify(rememberTool);
      expect(rememberTool).toBeDefined();
      expect(serializedTool).not.toContain("USER.md");
      expect(serializedTool).not.toContain(".vykor");
      expect(serializedTool).not.toContain(cwd);
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gives settings and capability override memory disables identical behavior", async () => {
    const settingsCwd = mkdtempSync(join(tmpdir(), "vykor-sdk-settings-memory-disabled-"));
    const overrideCwd = mkdtempSync(join(tmpdir(), "vykor-sdk-override-memory-disabled-"));
    const settingsDisabled = await createDefaultNodeAgent({
      cwd: settingsCwd,
      settings: testSettings(),
    });
    const overrideDisabled = await createDefaultNodeAgent({
      cwd: overrideCwd,
      capabilityOverrides: { memory: false },
      settings: testSettingsWithDefaultMemory(),
    });

    try {
      expect(settingsDisabled.getCapabilities().memory).toEqual({ status: "disabled" });
      expect(overrideDisabled.getCapabilities().memory).toEqual({ status: "disabled" });
      expect(settingsDisabled.getCapabilities()).toEqual(overrideDisabled.getCapabilities());

      for (const agent of [settingsDisabled, overrideDisabled]) {
        expect(agent.inspect().tools.map((tool) => tool.name)).not.toContain("Remember");
        await expect(agent.remember()).resolves.toMatchObject({
          skipped: true,
          reason: "memory is disabled",
        });
      }
    } finally {
      await settingsDisabled.close();
      await overrideDisabled.close();
      rmSync(settingsCwd, { recursive: true, force: true });
      rmSync(overrideCwd, { recursive: true, force: true });
    }
  });

  it("keeps disabled long-running capabilities out of diagnostics, tools, and the model prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-disabled-capabilities-"));
    const requests: Array<Parameters<StreamingMessageClient["streamMessage"]>[0]> = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requests.push(params);
        yield { type: "text_delta" as const, delta: "restricted runtime" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      client,
      capabilityOverrides: {
        jobs: false,
        terminal: false,
        backgroundShell: false,
        childEnvironment: false,
        workflowRepository: false,
      },
      settings: testSettings(),
    });

    try {
      expect(agent.getCapabilities()).toMatchObject({
        jobs: { status: "disabled" },
        terminal: { status: "disabled" },
        backgroundShell: { status: "disabled" },
        childEnvironment: { status: "disabled" },
        workflowRepository: { status: "disabled" },
      });
      const installedTools = agent.inspect().tools.map((tool) => tool.name);
      const disabledToolNames = [
        "Agent",
        "BackgroundShellCreate",
        "JobList",
        "JobRead",
        "JobWait",
        "JobSend",
        "JobCancel",
        "TerminalOpen",
        "Workflow",
      ];
      expect(installedTools.filter((name) => disabledToolNames.includes(name))).toEqual([]);

      await expect(agent.runMessage("describe the restricted runtime")).resolves.toMatchObject({
        output: "restricted runtime",
      });
      const request = requests[0];
      const requestToolNames = request?.tools?.map((tool) => tool.name) ?? [];
      expect(requestToolNames.filter((name) => disabledToolNames.includes(name))).toEqual([]);
      expect(request?.system).not.toContain("BackgroundShellCreate");
      expect(request?.system).not.toContain("JobWait");
      expect(request?.system).not.toContain("JobRead");
      expect(request?.system).not.toContain("# Delegation And Subagents");
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("routes Workflow jobs through the injected repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-workflow-jobs-"));
    const workflows = new FileWorkflowRunRepository({ dir: join(cwd, "external-workflows") });
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    workflows.save(createWorkflowRunSnapshot({
      runId: "workflow-override",
      ownerSession: "session-1",
      status: "running",
      summary: "shared repository",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      createdAt: 10,
    }));
    let jobReadResult: unknown;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const toolResult = params.messages.find((message) => message.type === "tool_result");
        if (!toolResult || toolResult.type !== "tool_result") {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-workflow-job-read",
              name: "JobRead",
              input: { jobId: "workflow-override" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        const text = toolResult.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        jobReadResult = JSON.parse(text);
        yield { type: "text_delta" as const, delta: "workflow read" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      sessionId: "session-1",
      client,
      capabilityOverrides: { workflowRepository: workflows },
      settings: testSettings(),
    });

    try {
      await expect(agent.runMessage("read workflow job")).resolves.toMatchObject({
        output: "workflow read",
      });
      expect(jobReadResult).toMatchObject({
        kind: "job",
        action: "read",
        snapshot: { id: "workflow-override", kind: "workflow" },
      });
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not register Schedule tools when schedules are explicitly disabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-schedule-capability-"));
    const agent = await createDefaultNodeAgent({
      cwd,
      capabilityOverrides: { schedules: false },
      settings: testSettings(),
    });

    try {
      expect(agent.getCapabilities().schedules).toEqual({ status: "disabled" });
      expect(agent.inspect().tools.map((tool) => tool.name)).not.toContain("ScheduleCreate");
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs a complete turn without daemon, including events and permission decisions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-"));
    const reliableEvents: AgentEvent[] = [];
    const observedEvents: AgentEvent[] = [];
    const requestPermission = vi.fn(async () => ({
      status: "denied" as const,
      reason: "SDK integration test",
    }));
    let modelTurn = 0;
    const client: StreamingMessageClient = {
      async *streamMessage() {
        modelTurn++;
        if (modelTurn === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "tool-sdk-1",
              name: "Shell",
              input: { command: "echo should-not-run" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta" as const, delta: "hello from sdk" };
        yield {
          type: "usage" as const,
          usage: { inputTokens: 3, outputTokens: 4 },
        };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const settings: Settings = {
      apiFormat: "anthropic",
      model: "sdk-test-model",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };

    const agent = await createDefaultNodeAgent({
      cwd,
      settings,
      client,
      effects: { requestPermission },
      onEvent: (event) => { reliableEvents.push(event); },
    });
    agent.subscribe(() => { throw new Error("observer failures are isolated"); });
    const unsubscribe = agent.subscribe((event) => { observedEvents.push(event); });

    try {
      const run = agent.submitMessage("say hello");
      await expect(run.result).resolves.toEqual(expect.objectContaining({
        status: "completed",
        output: "hello from sdk",
      }));

      expect(requestPermission).toHaveBeenCalledOnce();
      expect(modelTurn).toBe(2);
      expect(reliableEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "run.started",
          "permission.requested",
          "permission.resolved",
          "tool.completed",
          "output.text.delta",
          "run.completed",
        ]),
      );
      expect(observedEvents.map((event) => event.type)).toEqual(
        reliableEvents.map((event) => event.type),
      );
      expect(agent.getHistory().length).toBeGreaterThanOrEqual(4);
    } finally {
      unsubscribe();
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("closes Agent -> JobWait through the standalone Jobs host", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-child-"));
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        if (firstUserText === "do delegated sdk work") {
          yield { type: "text_delta" as const, delta: "child sdk result" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        const toolResults = params.messages.filter((message) => message.type === "tool_result");
        if (toolResults.length === 0) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-agent-tool",
              name: "Agent",
              input: { description: "sdk child", prompt: "do delegated sdk work" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        if (toolResults.length === 1) {
          const text = toolResults[0]!.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          const jobId = (JSON.parse(text) as { jobId?: string }).jobId;
          if (!jobId) throw new Error(`Agent tool did not return jobId: ${text}`);
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-job-wait-tool",
              name: "JobWait",
              input: { jobIds: [jobId], timeoutSeconds: 2 },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        const waitText = toolResults.at(-1)!.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        yield { type: "text_delta" as const, delta: `root received: ${waitText}` };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const settings: Settings = {
      apiFormat: "anthropic",
      model: "sdk-child-test-model",
      maxTurns: 4,
      permission: { mode: "full_auto" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings,
      client,
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("delegate work").result;

      expect(result.output).toContain("child sdk result");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs Workflow through framework children without daemon services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-workflow-"));
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        if (firstUserText === "do workflow sdk work") {
          yield { type: "text_delta" as const, delta: "workflow child result" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        const toolResult = params.messages.find((message) => message.type === "tool_result");
        if (!toolResult || toolResult.type !== "tool_result") {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-workflow-tool",
              name: "Workflow",
              input: {
                mode: "sequential",
                persist: false,
                tasks: [{ id: "sdk-worker", prompt: "do workflow sdk work" }],
              },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        const workflowResult = toolResult.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        yield { type: "text_delta" as const, delta: workflowResult };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-workflow-test-model",
        maxTurns: 3,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      effects: { requestPermission: async () => ({ status: "approved" }) },
      capabilityOverrides: {
        workflowRepository: new FileWorkflowRunRepository({ cwd }),
      },
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("run workflow").result;

      expect(result.output).toContain("workflow child result");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs Coordinator -> Workflow -> worker -> Read/Shell/Edit with worker tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-coordinator-workflow-"));
    const targetFile = join(cwd, "target.txt");
    writeFileSync(targetFile, "alpha\n", "utf-8");
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        const usedTools = params.messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.type === "assistant" ? message.toolUses ?? [] : [])
          .map((toolUse) => toolUse.name);

        if (usedTools.includes("Workflow")) {
          const workflowResult = latestToolResultText(params.messages);
          yield { type: "text_delta" as const, delta: `coordinator received ${workflowResult}` };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (usedTools.includes("Read") && usedTools.includes("Shell") && usedTools.includes("Edit")) {
          const workerResults = params.messages
            .filter((message) => message.type === "tool_result")
            .map((message) => message.type === "tool_result"
              ? message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
              : "")
            .join("\n");
          expect(workerResults).toContain("1: alpha");
          expect(workerResults).toContain("bash-ok");
          expect(workerResults).toContain("Successfully edited");
          yield { type: "text_delta" as const, delta: "worker completed Read/Shell/Edit" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (firstUserText.includes("perform real worker tools")) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-read",
              name: "Read",
              input: { file_path: targetFile },
            },
          };
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-bash",
              name: "Shell",
              input: { command: "echo bash-ok", workdir: cwd, timeout: 10_000 },
            },
          };
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-edit",
              name: "Edit",
              input: { file_path: targetFile, old_string: "alpha", new_string: "beta" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        yield {
          type: "tool_use_start" as const,
          toolUse: {
            type: "tool_use" as const,
            id: "coordinator-workflow",
            name: "Workflow",
            input: {
              mode: "sequential",
              persist: false,
              waitForCompletion: true,
              tasks: [{
                id: "real-worker-tools",
                prompt: "perform real worker tools",
              }],
            },
          },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-coordinator-workflow-test-model",
        maxTurns: 5,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      effects: { requestPermission: async () => ({ status: "approved" }) },
      capabilityOverrides: {
        workflowRepository: new FileWorkflowRunRepository({ cwd }),
      },
      roleAllowedTools: [
        "Workflow",
        "JobList",
        "JobRead",
        "JobWait",
        "JobSend",
        "JobCancel",
        "Agent",
      ],
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("run coordinator workflow").result;

      expect(result.output).toContain("worker completed Read/Shell/Edit");
      expect(readFileSync(targetFile, "utf-8")).toBe("beta\n");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events
        .filter((event) => event.type === "tool.started")
        .map((event) => event.type === "tool.started" ? event.data.toolUse.name : ""))
        .toEqual(expect.arrayContaining(["Workflow", "Read", "Shell", "Edit"]));
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("keeps child worker tools under the SDK host allowlist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-sdk-child-ceiling-"));
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        const usedTools = params.messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.type === "assistant" ? message.toolUses ?? [] : [])
          .map((toolUse) => toolUse.name);

        if (usedTools.includes("JobWait")) {
          const waitText = latestToolResultText(params.messages);
          yield { type: "text_delta" as const, delta: waitText };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (usedTools.includes("Agent")) {
          const toolResult = toolResultText(params.messages, "spawn-restricted-child");
          const jobId = (JSON.parse(toolResult) as { jobId?: string }).jobId;
          if (!jobId) throw new Error(`Agent tool did not return jobId: ${toolResult}`);
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "wait-restricted-child",
              name: "JobWait",
              input: { jobIds: [jobId], timeoutSeconds: 2 },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        if (usedTools.includes("Shell")) {
          yield { type: "text_delta" as const, delta: latestToolResultText(params.messages) };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (firstUserText === "child tries bash") {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "forbidden-bash",
              name: "Shell",
              input: { command: "echo should-not-run", workdir: cwd },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        yield {
          type: "tool_use_start" as const,
          toolUse: {
            type: "tool_use" as const,
            id: "spawn-restricted-child",
            name: "Agent",
            input: { description: "restricted child", prompt: "child tries bash" },
          },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-child-ceiling-test-model",
        maxTurns: 5,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      hostToolCeiling: ["Read", "Agent", "JobWait"],
    });

    try {
      const result = await agent.submitMessage("spawn restricted worker").result;

      expect(result.output).toContain("Unknown tool: Shell");
      expect(result.output).not.toContain("should-not-run");
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

function latestToolResultText(messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"]): string {
  const latest = messages.filter((message) => message.type === "tool_result").at(-1);
  if (!latest || latest.type !== "tool_result") return "";
  return latest.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toolResultText(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): string {
  const result = messages.find((message) =>
    message.type === "tool_result" && message.toolUseId === toolUseId
  );
  if (!result || result.type !== "tool_result") return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function hasToolResult(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): boolean {
  return messages.some((message) =>
    message.type === "tool_result" && message.toolUseId === toolUseId
  );
}

function toolResultPayload(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): Record<string, any> {
  const text = toolResultText(messages, toolUseId);
  if (!text) throw new Error(`Missing tool result: ${toolUseId}`);
  return JSON.parse(text) as Record<string, any>;
}

function terminalIdFromResult(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): string {
  const payload = toolResultPayload(messages, toolUseId);
  const terminal = payload.terminal as { id?: unknown } | undefined;
  if (typeof terminal?.id !== "string") {
    throw new Error(`Terminal tool did not return an id: ${JSON.stringify(payload)}`);
  }
  return terminal.id;
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "tool_use_start" as const,
    toolUse: { type: "tool_use" as const, id, name, input },
  };
}

function testSettings(): Settings {
  return {
    apiFormat: "anthropic",
    model: "sdk-capability-test-model",
    maxTurns: 3,
    permission: { mode: "full_auto" },
    sandbox: { enabled: false },
    memory: { enabled: false },
  };
}

function testSettingsWithDefaultMemory(): Settings {
  return {
    apiFormat: "anthropic",
    model: "sdk-capability-test-model",
    maxTurns: 3,
    permission: { mode: "full_auto" },
    sandbox: { enabled: false },
  };
}
