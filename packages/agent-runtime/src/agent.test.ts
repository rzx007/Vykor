import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QueryEngine,
  type AgentEvent,
  AgentRunNotAcceptingInputError,
  RuntimeBundle,
  type StreamingMessageClient,
  type Settings,
} from "@openharness/core";
import { McpClientManager } from "@openharness/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOperationConflictError } from "./agent.js";
import { createDefaultNodeAgent } from "./default-agent.js";
import * as defaultNodeTerminal from "./default-node-terminal.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createDefaultNodeAgent", () => {
  it("denies an ask decision when no permission effect is configured", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-permission-"));
    tempDirs.push(cwd);
    const events: AgentEvent[] = [];
    let turn = 0;
    const client: StreamingMessageClient = {
      async *streamMessage() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "permission-test-tool",
              name: "Shell",
              input: { command: "echo must-not-run" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }
        yield { type: "text_delta" as const, delta: "permission handled" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      client,
      settings: {
        apiFormat: "anthropic",
        model: "permission-test-model",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      onEvent: (event) => events.push(event),
    });

    try {
      await expect(agent.runMessage("run a command")).resolves.toMatchObject({
        output: "permission handled",
      });
      expect(events.find((event) => event.type === "permission.resolved")).toMatchObject({
        data: {
          decision: {
            status: "denied",
            reason: "No permission effect configured",
          },
        },
      });
    } finally {
      await agent.close();
    }
  });

  it("constructs a standalone programmatic agent without daemon services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };

    const agent = await createDefaultNodeAgent({ cwd, settings });

    expect(agent.id).toMatch(/^agent_session_/);
    expect(agent.subscribe).toBeTypeOf("function");
    expect(agent.children.list()).toEqual([]);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.inspect().tools.length).toBeGreaterThan(0);
    expect(agent.inspect().tools).toContainEqual({
      name: "Remember",
      source: { kind: "runtime", id: "memory" },
    });
    expect(agent.inspect().model).toBe("claude-test");
    expect(agent.getUsage()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    await agent.close();
  });

  it("releases MCP connection leases after a Run settles", async () => {
    const release = vi.fn();
    const retain = vi.spyOn(McpClientManager.prototype, "retainCurrentConnections").mockReturnValue(release);
    expect("retainMcpConnectionsForRun" in QueryEngine.prototype).toBe(false);
    const agent = await createDefaultNodeAgent({
      client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
      settings: {
        model: "test",
        apiFormat: "anthropic",
        maxTurns: 2,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
    });
    try {
      await agent.runMessage("finish");
      expect(retain).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await agent.close();
    }
  });

  it("exposes caller tool override provenance through the public API", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-tool-"));
    tempDirs.push(cwd);
    const replacement = {
      name: "Read",
      description: "Read through the caller resource service",
      inputSchema: {},
      async execute() { return { content: [] }; },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "tool-test-model",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      toolOverrides: [replacement],
    });

    try {
      expect(agent.inspect().tools).toContainEqual({
        name: "Read",
        source: { kind: "agent" },
        overrides: { kind: "builtin" },
      });
    } finally {
      await agent.close();
    }
  });

  it("closes the runtime exactly once and preserves an extension setup failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const setupError = new Error("extension setup failed");
    const runtimeClose = vi.spyOn(RuntimeBundle.prototype, "close");

    const creation = createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      extensions: [{ setup: () => { throw setupError; } }],
    });

    await expect(creation).rejects.toBe(setupError);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("isolates a failed MCP connection and records it without leaking resources", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const connectionError = new Error("MCP connection setup failed");
    const runtimeClose = vi.spyOn(RuntimeBundle.prototype, "close");
    const recordFailed = vi.spyOn(McpClientManager.prototype, "recordFailedConnection");
    vi.spyOn(McpClientManager.prototype, "prepareConnection").mockRejectedValueOnce(connectionError);

    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      mcpServers: {
        partial: { type: "stdio", command: "partial-mcp" },
      },
    });

    expect(recordFailed).toHaveBeenCalledWith("partial", expect.anything(), connectionError);
    expect(agent.inspect().mcpServers).toEqual([
      expect.objectContaining({ name: "partial", status: "error" }),
    ]);
    expect(runtimeClose).not.toHaveBeenCalled();
    await agent.close();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("aggregates creation and cleanup failures in original-first order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const setupError = new Error("extension setup failed");
    const cleanupError = new Error("runtime cleanup failed");
    const runtimeClose = vi
      .spyOn(RuntimeBundle.prototype, "close")
      .mockRejectedValueOnce(cleanupError);

    const failure = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      extensions: [{ setup: () => { throw setupError; } }],
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError]);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("rolls back an owned default terminal after MCP initialization fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const connectionError = new Error("MCP initialization failed");
    const cleanup = vi.fn(async () => {});
    vi.spyOn(McpClientManager.prototype, "prepareConnection").mockResolvedValueOnce({
      name: "failing",
      connection: { status: "connected" },
      client: { close: vi.fn(async () => {}) },
      transport: {},
      tools: [],
    } as never);
    vi.spyOn(McpClientManager.prototype, "activatePreparedConnection").mockReturnValueOnce({
      committed: false,
      error: connectionError,
      discardPrepared: async () => {},
    });
    vi.spyOn(defaultNodeTerminal, "createDefaultNodeTerminal").mockResolvedValueOnce({
      value: {
        value: {
          async open() {
            throw new Error("not used");
          },
        },
        jobs: {} as never,
      },
      cleanup,
      cleanupIdentity: {},
    });

    const failure = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      mcpServers: { failing: { type: "stdio", command: "not-started" } },
    }).catch((error) => error);

    expect(failure).toBe(connectionError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("composes default terminal jobs and disposes the owned bundle once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const cleanup = vi.fn(async () => {});
    const terminalJob = {
      id: "terminal-job-1",
      kind: "terminal" as const,
      ownerSession: "session-1",
      status: "running" as const,
      capabilities: { read: true, wait: true, send: true, cancel: true },
      cwd,
      startedAt: 1,
      updatedAt: 1,
    };
    vi.spyOn(defaultNodeTerminal, "createDefaultNodeTerminal").mockResolvedValueOnce({
      value: {
        value: {
          async open() {
            throw new Error("not used");
          },
        },
        jobs: {
          async list(input) {
            return [{ ...terminalJob, ownerSession: input.sessionId }];
          },
          async read() { throw new Error("not used"); },
          async wait() { throw new Error("not used"); },
          async send() {},
          async cancel() { throw new Error("not used"); },
        },
      },
      cleanup,
      cleanupIdentity: {},
    });
    const agent = await createDefaultNodeAgent({
      cwd,
      sessionId: "session-1",
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });

    expect(agent.getCapabilities().terminal).toEqual({
      status: "available",
      source: "default",
    });
    await expect((agent as any).capabilities.jobs.value.list({
      sessionId: agent.id,
    })).resolves.toContainEqual(terminalJob);

    await agent.close();
    await agent.close();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("borrows a Host terminal without calling its cleanup hooks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-host-terminal-"));
    tempDirs.push(cwd);
    const createLocalTerminal = vi.spyOn(
      defaultNodeTerminal,
      "createDefaultNodeTerminal",
    );
    const dispose = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const terminalOverride = {
      value: {
        async open() { throw new Error("not used"); },
        dispose,
      },
      jobs: {} as never,
      cleanup,
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      capabilityOverrides: { terminal: terminalOverride },
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });

    await agent.close();
    await agent.close();

    expect(agent.getCapabilities().terminal).toEqual({
      status: "available",
      source: "override",
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(createLocalTerminal).not.toHaveBeenCalled();
  });

  it("rejects an accepted steer when the run fails before a turn boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({ cwd, settings });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      throw new Error("provider failed before boundary");
    };

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const steer = run.steer({ id: "input-steer", content: "follow up" });

    await expect(run.result).rejects.toThrow("provider failed before boundary");
    await expect(steer).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });

  it("settles concurrent steers one boundary at a time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings,
      onEvent: (event) => {
        if (event.type === "input.accepted" && event.context.inputId === "input-steer-2") {
          throw new Error("second projection failed");
        }
      },
    });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      yield { type: "complete", stopReason: "end_turn" };
    };

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const first = run.steer({ id: "input-steer-1", content: "first" });
    const second = run.steer({ id: "input-steer-2", content: "second" });

    await expect(first).resolves.toEqual({
      sessionId: agent.id,
      inputId: "input-steer-1",
      runId: "run-root",
    });
    await expect(run.result).rejects.toThrow("second projection failed");
    await expect(second).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });

  it("tracks completed memory run boundaries across steering and later submissions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-memory-run-"));
    tempDirs.push(cwd);
    const configDir = mkdtempSync(join(tmpdir(), "openharness-agent-memory-config-"));
    const previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
    const events: AgentEvent[] = [];
    let conversationTurns = 0;
    let extractionCalls = 0;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.tools?.length === 0) {
          extractionCalls++;
          yield { type: "text_delta" as const, delta: '{"memories":[]}' };
          yield { type: "complete" as const, stopReason: "end_turn" as const };
          return;
        }

        conversationTurns++;
        if (conversationTurns === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "remember-before-steer",
              name: "Remember",
              input: {
                scope: "project",
                content: "Build commands use pnpm.",
              },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" as const };
          return;
        }

        yield {
          type: "text_delta" as const,
          delta: conversationTurns === 2 ? "steered run complete" : "next run complete",
        };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    try {
      const agent = await createDefaultNodeAgent({
        cwd,
        client,
        settings: {
          apiFormat: "anthropic",
          model: "memory-run-boundary-test-model",
          maxTurns: 4,
          permission: { mode: "full_auto" },
          sandbox: { enabled: false },
        },
        onEvent: (event) => events.push(event),
      });

      try {
        agent.loadHistory([
        { type: "user", content: "old run" },
        { type: "assistant", content: "old answer" },
      ]);
      const runtime = (agent as any).runtime;
      runtime.queryEngine.compactService.autoCompact = async (
        history: Array<{ type: string }>,
      ) => history.filter((message) => message.type === "user").slice(-1);

      const firstRun = agent.submitMessage("remember before steering");
      const steer = firstRun.steer({
        id: "memory-steer",
        content: "finish this same run",
      });

      await expect(steer).resolves.toMatchObject({ runId: firstRun.id });
      await expect(firstRun.result).resolves.toMatchObject({
        output: "steered run complete",
      });
      const rememberCompleted = events.find((event) =>
        event.type === "tool.completed" && event.data.toolUseId === "remember-before-steer",
      );
      expect(rememberCompleted).toMatchObject({
        type: "tool.completed",
        data: expect.objectContaining({
          toolUseId: "remember-before-steer",
          result: expect.objectContaining({
            content: [expect.objectContaining({ text: "Remembered this project information." })],
          }),
        }),
      });
      expect(rememberCompleted).not.toMatchObject({
        data: { result: { isError: true } },
      });
      expect(agent.getHistory()).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "assistant",
          toolUses: expect.arrayContaining([
            expect.objectContaining({ name: "Remember" }),
          ]),
        }),
      ]));
      runtime.queryEngine.compact = async () => {
        runtime.queryEngine.loadMessages([
          { type: "user", content: "compacted current history" },
          { type: "assistant", content: "summary without tool calls" },
        ]);
      };
      await agent.compact();
      await expect(agent.remember()).resolves.toMatchObject({
        skipped: true,
        reason: "main conversation already wrote memory",
      });
      expect(extractionCalls).toBe(0);

      agent.loadHistory([
        { type: "user", content: "loaded history without memory writes" },
        { type: "assistant", content: "loaded answer" },
      ]);
      await expect(agent.remember()).resolves.toMatchObject({
        skipped: true,
        reason: "no durable memories proposed",
      });
      expect(extractionCalls).toBe(1);

      await expect(agent.runMessage("a new independent run")).resolves.toMatchObject({
        output: "next run complete",
      });
      await expect(agent.remember()).resolves.toMatchObject({
        skipped: true,
        reason: "no durable memories proposed",
      });
        expect(extractionCalls).toBe(2);
      } finally {
        await agent.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.each(["failure", "cancellation"] as const)(
    "does not keep successful tool activity from a run ending in %s",
    async (ending) => {
      const cwd = mkdtempSync(join(tmpdir(), `openharness-agent-memory-${ending}-`));
      tempDirs.push(cwd);
      let conversationTurns = 0;
      let extractionCalls = 0;
      let markSecondTurnStarted!: () => void;
      const secondTurnStarted = new Promise<void>((resolve) => {
        markSecondTurnStarted = resolve;
      });
      const client: StreamingMessageClient = {
        async *streamMessage(params) {
          if (params.tools?.length === 0) {
            extractionCalls++;
            yield { type: "text_delta" as const, delta: '{"memories":[]}' };
            yield { type: "complete" as const, stopReason: "end_turn" as const };
            return;
          }

          conversationTurns++;
          if (conversationTurns === 1) {
            yield {
              type: "tool_use_start" as const,
              toolUse: {
                type: "tool_use" as const,
                id: `remember-before-${ending}`,
                name: "Remember",
                input: {
                  scope: "project",
                  content: "Build commands use pnpm.",
                },
              },
            };
            yield { type: "complete" as const, stopReason: "tool_use" as const };
            return;
          }

          markSecondTurnStarted();
          if (ending === "failure") throw new Error("provider failed after Remember");
          await new Promise<never>((_resolve, reject) => {
            const signal = params.abortSignal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      };
      const agent = await createDefaultNodeAgent({
        cwd,
        client,
        settings: {
          apiFormat: "anthropic",
          model: "memory-failed-run-test-model",
          maxTurns: 3,
          permission: { mode: "full_auto" },
          sandbox: { enabled: false },
        },
      });

      try {
        const run = agent.submitMessage(`remember before ${ending}`);
        await secondTurnStarted;
        if (ending === "cancellation") await run.interrupt("cancel after Remember");
        await expect(run.result).rejects.toBeDefined();

        await expect(agent.remember()).resolves.toMatchObject({
          skipped: true,
          reason: "no durable memories proposed",
        });
        expect(extractionCalls).toBe(1);
      } finally {
        await agent.close();
      }
    },
  );

  it("serializes runs, maintenance, context mutation, and close through one lifecycle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({ cwd, settings });
    const compactContextProvider = () => ({
      sessionMemory: "current compact checkpoint",
    });
    const setCompactContextProvider = vi.spyOn(
      (agent as any).runtime.queryEngine,
      "setCompactContextProvider",
    );
    agent.setCompactContextProvider(compactContextProvider);
    expect(setCompactContextProvider).toHaveBeenCalledWith(compactContextProvider);
    let finishCompact!: () => void;
    (agent as any).runtime.queryEngine.compact = () => new Promise<void>((resolve) => {
      finishCompact = resolve;
    });

    const compact = agent.compact();
    expect(agent.state).toBe("maintaining");
    expect(() => agent.submitMessage("late run")).toThrow(AgentOperationConflictError);
    expect(() => agent.loadHistory([])).toThrow(AgentOperationConflictError);
    expect(() => agent.clear()).toThrow(AgentOperationConflictError);
    expect(() => agent.setModel("other-model")).toThrow(AgentOperationConflictError);
    expect(() => agent.setCompactContextProvider(undefined)).toThrow(
      AgentOperationConflictError,
    );

    const closing = agent.close();
    expect(agent.state).toBe("closing");
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishCompact();
    await compact;
    await closing;
    expect(agent.state).toBe("closed");
    expect(() => agent.submitMessage("after close")).toThrow(AgentOperationConflictError);
  });

  it("attempts every cleanup stage and reports failures after becoming closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });
    const childError = new Error("child cleanup failed");
    (agent as any).childManager.closeAll = async () => { throw childError; };
    const runtimeClose = vi.spyOn((agent as any).runtime, "close");

    await expect(agent.close()).rejects.toBe(childError);
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(agent.state).toBe("closed");
  });

  it("still closes children, events, and runtime when default terminal cleanup fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const capabilityError = new Error("terminal cleanup failed");
    const terminalCleanup = vi.fn(async () => { throw capabilityError; });
    vi.spyOn(defaultNodeTerminal, "createDefaultNodeTerminal").mockResolvedValueOnce({
      value: {
        value: { async open() { throw new Error("not used"); } },
        jobs: {} as never,
      },
      cleanup: terminalCleanup,
      cleanupIdentity: {},
    });
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });
    const childClose = vi.spyOn((agent as any).childManager, "closeAll");
    const eventDrain = vi.spyOn((agent as any).eventBus, "drain");
    const runtimeClose = vi.spyOn((agent as any).runtime, "close");

    await expect(agent.close()).rejects.toBe(capabilityError);
    expect(terminalCleanup).toHaveBeenCalledOnce();
    expect(childClose).toHaveBeenCalledOnce();
    expect(eventDrain).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(agent.state).toBe("closed");
  });

  it("aggregates multiple cleanup failures in lifecycle order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });
    const childError = new Error("child cleanup failed");
    const capabilityError = new Error("capability cleanup failed");
    const eventError = new Error("event drain failed");
    const runtimeError = new Error("runtime cleanup failed");
    (agent as any).childManager.closeAll = vi.fn(async () => { throw childError; });
    (agent as any).closeOwnedCapabilities = vi.fn(async () => { throw capabilityError; });
    (agent as any).eventBus.drain = vi.fn(async () => { throw eventError; });
    (agent as any).runtime.close = vi.fn(async () => { throw runtimeError; });

    const closing = agent.close();
    const failure = await closing.catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      childError,
      capabilityError,
      eventError,
      runtimeError,
    ]);
    expect(await agent.close().catch((error) => error)).toBe(failure);
    expect((agent as any).childManager.closeAll).toHaveBeenCalledOnce();
    expect((agent as any).closeOwnedCapabilities).toHaveBeenCalledOnce();
    expect((agent as any).eventBus.drain).toHaveBeenCalledOnce();
    expect((agent as any).runtime.close).toHaveBeenCalledOnce();
    expect(agent.state).toBe("closed");
  });
});
