import type { AgentRunHandle } from "@openharness/core";
import type { AgentCapabilitySnapshot } from "@openharness/agent-runtime";
import { createRunCapabilityView } from "@openharness/agent-runtime";
import { ToolRegistry } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { SessionRunExecutor } from "../session-run-executor.js";

describe("SessionRunExecutor", () => {
  it("records a selected plugin preparation failure before submitting to the model", async () => {
    const store = createStore();
    Object.assign(store.getRun(), { metadata: { pluginId: "selected", retained: "yes" } });
    let modelCalls = 0;
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: { configured: true, acquireSession: async () => ({
        setModel: () => {},
        createRunCapabilityView: (pluginId?: string) => createRunCapabilityView({
          toolRegistry: new ToolRegistry(), pluginIds: new Set(["selected"]),
          pluginPreparationErrors: new Map([["selected", ["Native Tools: registration exploded"]]]),
        }, pluginId),
        submitMessage: () => { modelCalls++; return completedHandle(); },
      }), close: async () => {}, closeIfStale: async () => {} } as any,
      events: { checkpoint: () => 1, publishSince: () => {} },
      transcriptProjection: { finalizeRunParts: () => {} } as any,
      traceIdForRun: () => "trace-1", log: () => {},
    });
    await executor.execute({ sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: async () => {} });
    expect(modelCalls).toBe(0);
    expect(store.getRun()).toMatchObject({
      status: "failed", error: expect.stringContaining("registration exploded"),
      metadata: { pluginId: "selected", retained: "yes", pluginPreparation: {
        status: "failed", pluginId: "selected", error: expect.stringContaining("registration exploded"),
      } },
    });
  });
  it("materializes a plugin-agent-only input using the captured View description, never its body", async () => {
    const store = createStore();
    store.getInput.mockReturnValue({ ...store.getInput(), items: [{ type: "capability", kind: "plugin_agent", pluginId: "selected", agentId: "selected:review", displayName: "Spoofed label" }], content: "@Spoofed label" } as any);
    Object.assign(store.getRun(), { metadata: { pluginId: "selected" } });
    const view = createRunCapabilityView({ toolRegistry: new ToolRegistry(), pluginIds: new Set(["selected"]), agents: [{ ownerPluginId: "selected", definition: {
      name: "selected:review", description: "Trusted review description", systemPrompt: "SECRET child body",
    } }] }, "selected");
    let submitted = "";
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: { configured: true, acquireSession: async () => ({
        setModel: () => {}, createRunCapabilityView: () => view,
        submitMessage: (content: string) => { submitted = content; return completedHandle(); },
      }), close: async () => {}, closeIfStale: async () => {} } as any,
      events: { checkpoint: () => 1, publishSince: () => {} }, transcriptProjection: { finalizeRunParts: () => {} } as any,
      traceIdForRun: () => "trace-1", log: () => {},
    });
    await executor.execute({ sessionId: "s1", inputId: "input-1", runId: "run-1" }, { signal: new AbortController().signal, registerHandle: async () => {} });
    expect(submitted).toContain('"subagentType":"selected:review"');
    expect(submitted).toContain("Trusted review description");
    expect(submitted).not.toContain("SECRET child body");
  });
  it("builds from the warm runtime using the durable Run owner and passes its captured bindings", async () => {
    const store = createStore({ metadata: { pluginId: "forged-input-owner" } });
    Object.assign(store.getRun(), { metadata: { pluginId: "selected" } });
    const registry = new ToolRegistry();
    registry.register({ name: "Selected", description: "selected", inputSchema: {}, execute: async () => ({ content: [] }) },
      { kind: "plugin", id: "selected" });
    const observed: string[][] = [];
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: async () => ({
          setModel: () => {},
          createRunCapabilityView: (pluginId?: string) => createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(["selected"]) }, pluginId),
          submitMessage: (_content: unknown, options: any) => {
            observed.push([options.capabilityView?.pluginId, ...options.capabilityView?.tools.keys() ?? []]);
            return completedHandle();
          },
        }),
        close: async () => {}, closeIfStale: async () => {},
      } as any,
      events: { checkpoint: () => 1, publishSince: () => {} },
      transcriptProjection: { finalizeRunParts: () => {} } as any,
      traceIdForRun: () => "trace-1", log: () => {},
    });
    await executor.execute({ sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: async () => {} });
    expect(observed).toEqual([["selected", "Selected"]]);
  });

  it("submits admitted identities and registers the live run handle", async () => {
    const handle = completedHandle();
    const submitMessage = vi.fn(() => handle);
    const agent = { setModel: vi.fn(), submitMessage };
    const store = createStore();
    const registerHandle = vi.fn(async () => {});
    const postRunMaintenance = { run: vi.fn(async () => {}) };
    const closeIfStale = vi.fn(async () => {});
    const executorWithMaintenance = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: vi.fn(async () => agent),
        close: vi.fn(async () => {}),
        closeIfStale,
      } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
      transcriptProjection: { finalizeRunParts: vi.fn() },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
      postRunMaintenance,
    });

    await executorWithMaintenance.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle },
    );

    expect(submitMessage).toHaveBeenCalledWith("hello", {
      inputItems: [{ type: "text", text: "hello" }],
      signal: expect.any(AbortSignal),
      delivery: "queue",
      metadata: { requestedBy: "test", traceId: "trace-1" },
      ids: { inputId: "input-1", runId: "run-1", traceId: "trace-1" },
    });
    expect(registerHandle).toHaveBeenCalledWith(handle);
    expect(postRunMaintenance.run).toHaveBeenCalledWith("s1", "run-1", agent);
    expect(closeIfStale).toHaveBeenCalledWith("s1");
  });

  it("submits one ordered Skill instruction for structured skill items", async () => {
    const submitMessage = vi.fn(() => completedHandle());
    const store = createStore({
      items: [
        { type: "text", text: "draw " },
        { type: "skill", name: "archify", path: "/repo/.agents/skills/archify/SKILL.md" },
        { type: "text", text: " now " },
        { type: "skill", name: "review", path: "/repo/.agents/skills/review/SKILL.md" },
      ],
    });
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: vi.fn(async () => ({ setModel: vi.fn(), submitMessage })),
        close: vi.fn(),
      } as any,
      events: { checkpoint: () => 1, publishSince: vi.fn() },
      transcriptProjection: { finalizeRunParts: vi.fn() },
      resolveSkillCatalog: vi.fn(async () => ({
        resolvePath: (path: string) => ({
          "/repo/.agents/skills/archify/SKILL.md": { name: "archify", path },
          "/repo/.agents/skills/review/SKILL.md": { name: "review", path },
        }[path]),
      })),
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(submitMessage).toHaveBeenCalledWith(
      "用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：\n" +
        "1. archify (path: /repo/.agents/skills/archify/SKILL.md)\n" +
        "2. review (path: /repo/.agents/skills/review/SKILL.md)\n\n" +
        "用户输入：\ndraw $archify now $review",
      expect.objectContaining({
        metadata: { requestedBy: "test", traceId: "trace-1" },
      }),
    );
  });

  it("falls back to a durable failure when agent creation fails before events", async () => {
    const store = createStore();
    const publishSince = vi.fn();
    const close = vi.fn(async () => {});
    const finalizeRunParts = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: vi.fn(async () => { throw new Error("agent failed"); }),
        close,
      } as any,
      events: { checkpoint: () => 7, publishSince },
      transcriptProjection: { finalizeRunParts },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(close).toHaveBeenCalledWith("s1");
    expect(finalizeRunParts).toHaveBeenCalledWith("s1", "run-1", "failed");
    expect(store.updateRun).toHaveBeenCalledWith("run-1", { status: "failed", error: "agent failed" });
    expect(publishSince).toHaveBeenCalledWith(7);
  });

  it("terminalizes the durable run even when failed-agent cleanup also fails", async () => {
    const store = createStore();
    const closeError = new Error("close failed");
    const log = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: vi.fn(async () => { throw new Error("agent failed"); }),
        close: vi.fn(async () => { throw closeError; }),
      } as any,
      events: { checkpoint: () => 3, publishSince: vi.fn() },
      transcriptProjection: { finalizeRunParts: vi.fn() },
      traceIdForRun: () => "trace-1",
      log,
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(store.updateRun).toHaveBeenCalledWith("run-1", { status: "failed", error: "agent failed" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.agent.cleanup_failed",
      error: "close failed",
    }));
  });

  it("submits ordered native image blocks only after routing succeeds", async () => {
    const store = createStore({ attachments: [attachment("asset-1", 0)] });
    const submitMessage = vi.fn(() => completedHandle());
    const projectAttachmentTransformations = vi.fn();
    const checkpoint = vi.fn(() => 9);
    const publishSince = vi.fn();
    const cleanupResources = vi.fn(async () => {});
    const materializeRun = vi.fn(async () => cleanupResources);
    const routeAttachments = vi.fn(async () => ({
      content: [
        { type: "text" as const, text: "hello" },
        { type: "image" as const, source: { type: "file" as const, mediaType: "image/png", path: "D:/blobs/asset-1", sizeBytes: 4 } },
      ],
      decisions: [{ assetId: "asset-1", intent: "auto" as const, mediaType: "image/png", route: "native_image" as const }],
    }));
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: {
        configured: true,
        acquireSession: vi.fn(async () => ({
          setModel: vi.fn(),
          submitMessage,
          inspect: () => ({
            tools: [{ name: "ImageToText" }],
            capabilities: capabilitySnapshot("available"),
          }),
        })),
        close: vi.fn(),
      } as any,
      events: { checkpoint, publishSince },
      transcriptProjection: {
        finalizeRunParts: vi.fn(),
        projectAttachmentTransformations,
      },
      resolveCapabilities: vi.fn(async () => ({
        modelCapabilities: { image: "native" as const },
        providerCapabilities: { image: "native" as const, imageMediaTypes: ["image/png"] },
      })),
      routeAttachments,
      attachmentResources: { materializeRun },
      attachmentOcrAvailable: true,
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(submitMessage).toHaveBeenCalledWith(
      [
        { type: "text", text: "hello" },
        { type: "image", source: expect.objectContaining({ path: "D:/blobs/asset-1" }) },
      ],
      expect.any(Object),
    );
    expect(routeAttachments).toHaveBeenCalledWith(expect.objectContaining({
      attachmentOcrAvailable: true,
    }));
    expect(projectAttachmentTransformations).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(checkpoint).toHaveBeenCalled();
    expect(publishSince).toHaveBeenCalledWith(9);
    expect(publishSince.mock.invocationCallOrder[0]).toBeLessThan(
      submitMessage.mock.invocationCallOrder[0]!,
    );
    expect(materializeRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      runId: "run-1",
    }));
    expect(cleanupResources).toHaveBeenCalledOnce();
    expect(store.attachments.acquireAttachmentLeases).toHaveBeenCalledWith(
      expect.objectContaining({
        assetIds: ["asset-1"],
        ownerKind: "session_run",
        ownerId: "run-1",
      }),
    );
    expect(store.attachments.releaseAttachmentLeases).toHaveBeenCalledWith(
      "session_run",
      "run-1",
    );
    expect(store.attachments.acquireAttachmentLeases.mock.invocationCallOrder[0]).toBeLessThan(
      submitMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("settles a blocked attachment run after inspecting and then closes the agent", async () => {
    const store = createStore({ attachments: [attachment("asset-1", 0)] });
    const acquireSession = vi.fn(async () => ({
      setModel: vi.fn(),
      inspect: () => ({ tools: [], capabilities: capabilitySnapshot("disabled") }),
    }));
    const close = vi.fn();
    const projectAttachmentTransformations = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      attachments: store.attachments,
      goals: store as any,
      agentPool: { configured: true, acquireSession, close } as any,
      events: { checkpoint: () => 4, publishSince: vi.fn() },
      transcriptProjection: {
        finalizeRunParts: vi.fn(),
        projectAttachmentTransformations,
      },
      resolveCapabilities: vi.fn(async () => ({
        modelCapabilities: { image: "unsupported" as const },
        providerCapabilities: { image: "native" as const, imageMediaTypes: ["image/png"] },
      })),
      routeAttachments: vi.fn(async () => {
        const error = Object.assign(new Error("model does not support image input"), {
          name: "AttachmentRoutingError",
          code: "attachment_model_unsupported",
          retryable: false,
          assetIds: ["asset-1"],
          decisions: [{ assetId: "asset-1", intent: "auto", mediaType: "image/png", route: "blocked", reason: "attachment_model_unsupported" }],
        });
        throw error;
      }),
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(acquireSession).toHaveBeenCalledWith("s1");
    expect(close).toHaveBeenCalledWith("s1");
    expect(store.updateRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "failed",
      metadata: expect.objectContaining({
        attachmentRouting: expect.objectContaining({ code: "attachment_model_unsupported" }),
      }),
    }));
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ errorKind: "attachment_model_unsupported" }),
    }));
    expect(projectAttachmentTransformations).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "attachment_model_unsupported" }),
    );
  });
});

function capabilitySnapshot(
  imageToText: "available" | "disabled",
): AgentCapabilitySnapshot {
  const disabled = { status: "disabled" } as const;
  return {
    terminal: disabled,
    backgroundShell: disabled,
    jobs: disabled,
    attachments: disabled,
    memory: disabled,
    childEnvironment: disabled,
    workflowRepository: disabled,
    imageToText: imageToText === "available"
      ? { status: "available", source: "override" }
      : disabled,
    schedules: disabled,
  };
}

function createStore(options: {
  attachments?: ReturnType<typeof attachment>[];
  metadata?: Record<string, unknown>;
  items?: Array<{ type: "text"; text: string } | { type: "skill"; name: string; path: string }>;
} = {}) {
  const run = { id: "run-1", sessionId: "s1", inputId: "input-1", status: "pending" };
  return {
    transaction: <T>(work: () => T) => work(),
    getSession: vi.fn(() => ({
      id: "s1",
      cwd: "/repo",
      model: "gpt-test",
      metadata: { runtime: { model: "gpt-test" } },
    })),
    getInput: vi.fn(() => ({
      id: "input-1",
      sessionId: "s1",
      content: "hello",
      items: options.items ?? [{ type: "text", text: "hello" }],
      attachments: options.attachments ?? [],
      delivery: "queue",
      metadata: options.metadata ?? { requestedBy: "test", traceId: "trace-1" },
    })),
    getRun: vi.fn(() => run),
    appendEvent: vi.fn(),
    updateRun: vi.fn((id, update) => Object.assign(run, update, { id })),
    attachments: {
      acquireAttachmentLeases: vi.fn(() => []),
      renewAttachmentLeases: vi.fn(() => 1),
      releaseAttachmentLeases: vi.fn(() => 1),
    },
  };
}

function attachment(assetId: string, seq: number) {
  return {
    id: `ref-${assetId}`,
    sessionId: "s1",
    inputId: "input-1",
    assetId,
    seq,
    intent: "auto" as const,
    displayName: `${assetId}.png`,
    mediaType: "image/png",
    sizeBytes: 4,
    metadata: {},
    createdAt: 1,
  };
}

function completedHandle(): AgentRunHandle {
  return {
    id: "run-1",
    inputId: "input-1",
    sessionId: "s1",
    traceId: "trace-1",
    started: Promise.resolve({ sessionId: "s1", inputId: "input-1", runId: "run-1" }),
    result: Promise.resolve({
      status: "completed",
      output: "ok",
      history: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    steer: vi.fn(),
    interrupt: vi.fn(),
  };
}
