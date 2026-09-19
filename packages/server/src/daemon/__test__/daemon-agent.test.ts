import { describe, expect, it, vi } from "vitest";

vi.mock("@openharness/coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openharness/coordinator")>();
  return {
    ...actual,
    getCoordinatorSystemPrompt: () => "You are a **coordinator** test prompt.",
    getCoordinatorTools: () => [
      "Agent",
      "JobList",
      "JobRead",
      "JobWait",
      "JobSend",
      "JobCancel",
      "Workflow",
    ],
    getCoordinatorUserContext: vi.fn(() => ({
      workerToolsContext: "Workers spawned via the Agent tool have access to these tools: Agent, JobWait",
    })),
  };
});

vi.mock("@openharness/agent-runtime", () => ({
  createDefaultNodeAgent: vi.fn(async () => {
    throw new Error("createDefaultNodeAgent should not be used by this test");
  }),
}));

import { createDaemonAgentLoader } from "../daemon-agent.js";
import { getCoordinatorUserContext } from "@openharness/coordinator";
import { createDefaultNodeAgentWithInternals } from "../../../../agent-runtime/src/default-agent.js";

const session = {
  id: "session-1",
  cwd: "/repo",
  model: "model-from-session",
  metadata: {
    runtime: {
      model: "model-from-session",
      permissionMode: "plan",
      systemPrompt: "session prompt",
      maxTurns: 7,
      allowedTools: ["Read"],
      disallowedTools: ["Shell"],
      effort: "high",
      pluginsEnabled: false,
    },
  },
} as any;

describe("createDaemonAgentLoader", () => {
  it("returns no loader when the daemon has no Agent configuration", () => {
    expect(createDaemonAgentLoader({})).toBeUndefined();
  });

  it("passes a projectless cwd into the desktop-managed Agent environment", async () => {
    const projectless = {
      ...session,
      cwd: "D:\\Documents\\OpenHarness\\2026-09-07\\x1",
      projectId: undefined,
    };
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model", agentEnvironment: { kind: "wsl" }, sandbox: { enabled: false } } as any,
      executionSurface: "desktop_managed",
      createAgent,
    })!;

    await loader({ session: projectless, history: [], parts: [] });

    expect(createAgent.mock.calls[0]![0].options).toMatchObject({
      cwd: projectless.cwd,
      executionSurface: "desktop_managed",
    });
  });

  it("acquires one daemon-owned environment lease before creating an Agent", async () => {
    const lease = { environmentId: "env-1", release: vi.fn(async () => {}) } as any;
    const acquireEnvironment = vi.fn(async () => lease);
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      executionSurface: "desktop_managed",
      acquireEnvironment,
      createAgent,
    })!;

    await loader({ session, history: [], parts: [] });

    expect(acquireEnvironment).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: "default-model" }),
    );
    expect(createAgent.mock.calls[0]![0].options.executionEnvironment).toBe(lease);
  });

  it("releases an acquired environment when Agent creation fails", async () => {
    const lease = { release: vi.fn(async () => {}) } as any;
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      executionSurface: "desktop_managed",
      acquireEnvironment: vi.fn(async () => lease),
      createAgent: vi.fn(async () => { throw new Error("create failed"); }),
    })!;

    await expect(loader({ session, history: [], parts: [] })).rejects.toThrow("create failed");
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("creates one fully initialized Agent from durable session state", async () => {
    const sink = vi.fn(async () => {});
    const loadHistory = vi.fn();
    const close = vi.fn(async () => {});
    const agent = { loadHistory, close } as any;
    const requestPermission = vi.fn();
    const createAgent = vi.fn(async () => agent);
    const createEventSink = vi.fn(() => sink);
    const terminal = {} as any;
    const terminalJobs = {} as any;
    const backgroundShell = { create: vi.fn() } as any;
    const backgroundShellJobs = {} as any;
    const schedules = {} as any;
    const imageToTextTool = { name: "ImageToText", description: "ocr", inputSchema: {}, execute: vi.fn() } as any;
    const imageGenerationTool = { name: "ImageGeneration", description: "generate", inputSchema: {}, execute: vi.fn() } as any;
    const tools = vi.fn(async () => [imageToTextTool, imageGenerationTool]);
    const readOverride = { name: "Read", description: "attachments", inputSchema: {}, execute: vi.fn() } as any;
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      requestPermission,
      schedules,
      createEventSink,
      createTerminal: () => ({ value: terminal, jobs: terminalJobs }),
      createBackgroundShell: () => ({
        value: backgroundShell,
        jobs: backgroundShellJobs,
      }),
      tools,
      toolOverrides: [readOverride],
      trustedToolOverrides: ["Read"],
    })!;

    const loaded = await loader({ session, history: [], parts: [] });

    expect(loaded).toBe(agent);
    expect(createAgent).toHaveBeenCalledOnce();
    const context = createAgent.mock.calls[0]![0];
    expect(context.options).toMatchObject({
      cwd: "/repo",
      sessionId: "session-1",
      model: "model-from-session",
      permissionMode: "plan",
      systemPrompt: "session prompt",
      maxTurns: 7,
      hostToolCeiling: ["Read"],
      disallowedTools: ["Shell"],
      effort: "high",
      pluginsEnabled: false,
      capabilityOverrides: {
        terminal: { value: terminal, jobs: terminalJobs },
        backgroundShell: {
          value: backgroundShell,
          jobs: backgroundShellJobs,
        },
        schedules,
      },
      effects: { requestPermission },
      tools: [imageToTextTool, imageGenerationTool],
      toolOverrides: [readOverride],
      trustedToolOverrides: ["Read"],
    });
    expect(context.options).not.toHaveProperty("attachmentResourceRoot");
    expect(context.options.capabilityOverrides).not.toHaveProperty("attachments");
    expect(context.options.capabilityOverrides).not.toHaveProperty("imageToText");
    expect(context.options.tools).toContain(imageGenerationTool);
    expect(tools).toHaveBeenCalledWith(expect.objectContaining({
      session,
      settings: expect.objectContaining({ model: "default-model" }),
    }));
    expect(terminalJobs).not.toBe(backgroundShellJobs);
    expect(loadHistory).toHaveBeenCalledWith([]);
    expect(createEventSink).toHaveBeenCalledWith(agent, session);

    const event = { type: "run.started" } as any;
    await context.options.onEvent(event);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("passes the daemon Terminal override through the real default Agent without creating a local Terminal", async () => {
    const terminal = {} as any;
    const terminalJobs = {} as any;
    const createLocalTerminal = vi.fn(async () => {
      throw new Error("daemon must not create a local Terminal provider");
    });
    const loader = createDaemonAgentLoader({
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "default-model",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      } as any,
      createAgent: async ({ options }) =>
        createDefaultNodeAgentWithInternals(options, { createLocalTerminal }),
      createTerminal: () => ({ value: terminal, jobs: terminalJobs }),
    })!;

    const loaded = await loader({ session, history: [], parts: [] });
    try {
      expect(createLocalTerminal).not.toHaveBeenCalled();
      expect(loaded.getCapabilities().terminal).toEqual({
        status: "available",
        source: "override",
      });
    } finally {
      await loaded.close();
    }
  });

  it("loads Agent settings for the durable session cwd", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const getSettingsForCwd = vi.fn(async (cwd: string) => ({
      model: "cwd-model",
      sandbox: {
        enabled: cwd === "/repo",
      },
    } as any));
    const loader = createDaemonAgentLoader({
      settings: { model: "global-model", sandbox: { enabled: false } } as any,
      getSettingsForCwd,
      createAgent,
    })!;

    await loader({ session, history: [], parts: [] });

    expect(getSettingsForCwd).toHaveBeenCalledWith("/repo");
    expect(createAgent.mock.calls[0]![0].options.settings).toMatchObject({
      model: "cwd-model",
      sandbox: {
        enabled: true,
      },
    });
  });

  it("does not let session metadata bypass the persistent plugin master switch", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model", plugins: { enabled: false } } as any,
      createAgent,
    })!;

    await loader({
      session: {
        ...session,
        metadata: {
          runtime: {
            ...session.metadata.runtime,
            pluginsEnabled: true,
          },
        },
      },
      history: [],
      parts: [],
    });

    expect(createAgent.mock.calls[0]![0].options.pluginsEnabled).toBe(false);
  });

  it("turns durable coordinator sessions into coordinator Agents", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
    })!;

    await loader({
      session: {
        ...session,
        metadata: {
          ...session.metadata,
          runtime: {
            ...session.metadata.runtime,
            sessionMode: "coordinator",
            systemPrompt: "Keep updates short.",
            allowedTools: ["Shell"],
          },
        },
      },
      history: [],
      parts: [],
    });

    const options = createAgent.mock.calls[0]![0].options;
    expect(options.systemPrompt).toContain("You are a **coordinator**");
    expect(options.systemPrompt).toContain("## Runtime Context");
    expect(options.systemPrompt).toContain("Workers spawned via the Agent tool");
    expect(options.systemPrompt).toContain("## Additional Session Instructions");
    expect(options.systemPrompt).toContain("Keep updates short.");
    expect(options.hostToolCeiling).toEqual(["Shell"]);
    expect(options.roleAllowedTools).toEqual([
      "Agent",
      "JobList",
      "JobRead",
      "JobWait",
      "JobSend",
      "JobCancel",
      "Workflow",
    ]);
    expect(getCoordinatorUserContext).toHaveBeenCalledWith(
      [],
      expect.stringContaining(".openharness-ts"),
      { enabled: true, hostToolCeiling: ["Shell"] },
    );
  });

  it("passes durable SessionRecord.id into runtime options and keeps it stable across reloads", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
    })!;

    await loader({ session, history: [], parts: [] });
    await loader({ session, history: [], parts: [] });

    expect(createAgent.mock.calls[0]![0].options.sessionId).toBe(session.id);
    expect(createAgent.mock.calls[1]![0].options.sessionId).toBe(session.id);
    expect(createAgent.mock.calls[0]![0].options.sessionId).toBe("session-1");
  });

  it("gives child sessions their own durable session id in runtime options", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
    })!;
    const childSession = {
      ...session,
      id: "session-child-9",
    };

    await loader({ session, history: [], parts: [] });
    await loader({ session: childSession, history: [], parts: [] });

    expect(createAgent.mock.calls[0]![0].options.sessionId).toBe("session-1");
    expect(createAgent.mock.calls[1]![0].options.sessionId).toBe("session-child-9");
  });

  it("closes a newly created Agent when durable history cannot be restored", async () => {
    const error = new Error("bad history");
    const close = vi.fn(async () => {});
    const agent = { loadHistory: vi.fn(() => { throw error; }), close } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async () => agent),
    })!;

    await expect(loader({ session, history: [], parts: [] })).rejects.toThrow("bad history");
    expect(close).toHaveBeenCalledOnce();
  });

  it("buffers framework events emitted before the daemon sink can bind to the Agent", async () => {
    const event = { type: "run.started" } as any;
    const sink = vi.fn(async () => {});
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async ({ options }) => {
        await options.onEvent!(event);
        return agent;
      }),
      createEventSink: vi.fn(() => sink),
    })!;

    await expect(loader({ session, history: [], parts: [] })).resolves.toBe(agent);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("aggregates the history and cleanup errors in lifecycle order", async () => {
    const historyError = new Error("bad history");
    const closeError = new Error("close failed");
    const agent = {
      loadHistory: vi.fn(() => { throw historyError; }),
      close: vi.fn(async () => { throw closeError; }),
    } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async () => agent),
    })!;

    const failure = await loader({ session, history: [], parts: [] }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([historyError, closeError]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it("sends reasoning effort only when the model declares the chosen tier", async () => {
    const createAgent = vi.fn(async () => ({ loadHistory: vi.fn(), close: vi.fn() }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      resolveReasoningEfforts: async () => ["low", "high", "max"],
    })!;

    await loader({ session, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBe("high");

    createAgent.mockClear();
    const undeclared = { ...session, metadata: { runtime: { model: "m", effort: "xhigh" } } };
    await loader({ session: undeclared, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();

    createAgent.mockClear();
    const noSelection = { ...session, metadata: { runtime: { model: "m" } } };
    await loader({ session: noSelection, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();
  });

  it("degrades to no reasoning effort when the resolver throws", async () => {
    const createAgent = vi.fn(async () => ({ loadHistory: vi.fn(), close: vi.fn() }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      resolveReasoningEfforts: async () => {
        throw new Error("catalog offline");
      },
    })!;

    await loader({ session, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();
  });
});
