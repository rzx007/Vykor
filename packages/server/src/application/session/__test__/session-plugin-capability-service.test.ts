import type { PluginCapabilityInventory, PluginCapabilityOwner } from "@vykor/agent-runtime";
import type { SessionRecord, SessionUserInputItem } from "@vykor/protocol";
import { describe, expect, it, vi } from "vitest";

import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { SessionInteractionService } from "../session-interaction-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const pluginId = "dev.vykor.quality";
const agentId = `${pluginId}:reviewer`;
const session = { id: "s1", cwd: "/repo" } as SessionRecord;

describe("SessionPluginCapabilityService", () => {
  it.each(["bundled", "user", "project"] as const)(
    "returns an empty admission for an ordinary %s Skill",
    async (source) => {
      const service = capabilityService(inventory());

      await expect(service.admit(session, [{
        type: "skill",
        source,
        name: "ordinary",
        path: `/skills/${source}/ordinary/SKILL.md`,
      }])).resolves.toEqual({});
    },
  );

  it("merges plugin, plugin Skill and plugin Agent references by inventory identity", async () => {
    const service = capabilityService(inventory());
    const items: SessionUserInputItem[] = [
      {
        type: "capability",
        kind: "plugin",
        pluginId,
        displayName: "tampered plugin label",
      },
      {
        type: "skill",
        source: "plugin",
        name: "review",
        path: "/plugins/quality/skills/review/SKILL.md",
        displayName: "tampered Skill label",
      },
      {
        type: "capability",
        kind: "plugin_agent",
        pluginId,
        agentId,
        displayName: "tampered Agent label",
      },
    ];

    await expect(service.admit(session, items)).resolves.toEqual({ pluginId });
  });

  it.each([
    ["unknown", "dev.vykor.unknown", []],
    ["disabled", "dev.vykor.disabled", []],
    [
      "conflicting",
      "dev.vykor.conflicting",
      [{
        severity: "error",
        phase: "discover",
        code: "plugin_component_name_conflict",
        message: "conflict",
        pluginId: "dev.vykor.conflicting",
      }],
    ],
  ] as const)("rejects a %s plugin that is absent from the current inventory", async (_case, requestedId, diagnostics) => {
    const service = capabilityService(inventory({ diagnostics }));

    await expect(service.admit(session, [{
      type: "capability",
      kind: "plugin",
      pluginId: requestedId,
      displayName: "Untrusted Label",
    }])).rejects.toMatchObject({
      status: 409,
      message: "session_plugin_capability_unavailable",
    });
  });

  it("rejects references owned by different plugins", async () => {
    const second = "dev.vykor.release";
    const service = capabilityService(inventory({ extraPluginId: second }));

    await expect(service.admit(session, [
      { type: "capability", kind: "plugin", pluginId, displayName: "Quality" },
      { type: "capability", kind: "plugin", pluginId: second, displayName: "Release" },
    ])).rejects.toMatchObject({
      status: 409,
      message: "session_plugin_capability_conflict",
    });
  });

  it("uses inventory ownership when a plugin Skill source is forged", async () => {
    const second = "dev.vykor.release";
    const service = capabilityService(inventory({ extraPluginId: second }));

    await expect(service.admit(session, [
      {
        type: "skill",
        source: "user",
        name: "review",
        path: "/plugins/quality/skills/review/SKILL.md",
      },
      { type: "capability", kind: "plugin", pluginId: second, displayName: "Release" },
    ])).rejects.toMatchObject({
      status: 409,
      message: "session_plugin_capability_conflict",
    });
  });

  it("adds the admitted pluginId to Input and Run metadata before persistence", async () => {
    const { application, admitPromptAndMaybeRun } = applicationService(inventory());
    const items: SessionUserInputItem[] = [
      { type: "capability", kind: "plugin", pluginId, displayName: "Quality" },
      {
        type: "skill",
        source: "plugin",
        name: "review",
        path: "/plugins/quality/skills/review/SKILL.md",
      },
      {
        type: "capability",
        kind: "plugin_agent",
        pluginId,
        agentId,
        displayName: "Reviewer",
      },
    ];

    await application.admitPrompt("s1", {
      id: "plugin-input",
      items,
      metadata: { source: "desktop" },
    });

    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "plugin-input",
      items,
      metadata: { source: "desktop", pluginId },
      runMetadata: { pluginId },
    });
  });

  it("writes inventory ownership for a plugin Skill with a forged source", async () => {
    const { application, admitPromptAndMaybeRun } = applicationService(inventory());
    const items: SessionUserInputItem[] = [{
      type: "skill",
      source: "user",
      name: "review",
      path: "/plugins/quality/skills/review/SKILL.md",
    }];

    await application.admitPrompt("s1", { id: "forged-skill", items });

    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "forged-skill",
      items,
      metadata: { pluginId },
      runMetadata: { pluginId },
    });
  });

  it("rejects invalid plugin references before creating an Input or Run", async () => {
    const { application, store, admitPromptAndMaybeRun } = applicationService(inventory());

    await expect(application.admitPrompt("s1", {
      id: "invalid-plugin-input",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.vykor.missing",
        displayName: "Missing",
      }],
    })).rejects.toThrow("session_plugin_capability_unavailable");

    expect(admitPromptAndMaybeRun).not.toHaveBeenCalled();
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it("strips caller-supplied pluginId from an ordinary Input and Run", async () => {
    const { application, admitPromptAndMaybeRun } = applicationService(inventory());

    await application.admitPrompt("s1", {
      id: "ordinary-input",
      items: [{ type: "text", text: "hello" }],
      metadata: { pluginId: "dev.vykor.forged", source: "desktop" },
      runMetadata: { pluginId: "dev.vykor.forged", source: "desktop" },
    });

    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "ordinary-input",
      items: [{ type: "text", text: "hello" }],
      metadata: { source: "desktop" },
      runMetadata: { source: "desktop" },
    });
  });

  it("requires plugin capability steer to remain a queued draft", async () => {
    const { application, store, admitPromptAndMaybeRun } = applicationService(inventory());

    await expect(application.admitPrompt("s1", {
      id: "plugin-steer",
      delivery: "steer",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId,
        displayName: "Quality",
      }],
    })).rejects.toThrow("session_capability_requires_queued_run");

    expect(admitPromptAndMaybeRun).not.toHaveBeenCalled();
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it("creates a new recovery Run with the admitted pluginId", async () => {
    const sourceInput = {
      id: "plugin-input",
      sessionId: "s1",
      items: [{ type: "capability", kind: "plugin", pluginId, displayName: "Quality" }],
      attachments: [],
      metadata: { pluginId },
    };
    const sourceRun = {
      id: "plugin-run",
      sessionId: "s1",
      inputId: sourceInput.id,
      status: "interrupted",
      metadata: { pluginId },
    };
    const { application, replayInput } = applicationService(inventory(), {
      sourceInput,
      sourceRun,
    });

    await application.resumeRun("s1", sourceRun.id, {
      id: "plugin-recovery-run",
      traceId: "trace-recovery",
    });

    expect(replayInput).toHaveBeenCalledWith(sourceInput.id, {
      id: "plugin-recovery-run",
      metadata: {
        pluginId,
        recovery: {
          kind: "prompt_replay",
          sourceRunId: sourceRun.id,
          sourceInputId: sourceInput.id,
        },
      },
      traceId: "trace-recovery",
    });
  });

  it("strips caller-supplied pluginId from recovery metadata", async () => {
    const sourceInput = {
      id: "ordinary-input",
      sessionId: "s1",
      items: [{ type: "text", text: "hello" }],
      attachments: [],
      metadata: {},
    };
    const sourceRun = {
      id: "ordinary-run",
      sessionId: "s1",
      inputId: sourceInput.id,
      status: "interrupted",
      metadata: {},
    };
    const { application, replayInput } = applicationService(inventory(), {
      sourceInput,
      sourceRun,
    });

    await application.resumeRun("s1", sourceRun.id, {
      id: "ordinary-recovery-run",
      metadata: { pluginId: "dev.vykor.forged", source: "desktop" },
      traceId: "trace-recovery",
    });

    expect(replayInput).toHaveBeenCalledWith(sourceInput.id, {
      id: "ordinary-recovery-run",
      metadata: {
        source: "desktop",
        recovery: {
          kind: "prompt_replay",
          sourceRunId: sourceRun.id,
          sourceInputId: sourceInput.id,
        },
      },
      traceId: "trace-recovery",
    });
  });

  it("reuses an admitted plugin Input and Run without resolving inventory again", async () => {
    const existingInput = {
      id: "plugin-request",
      sessionId: "s1",
      delivery: "queue",
      items: [{ type: "capability", kind: "plugin", pluginId, displayName: "Quality" }],
      attachments: [],
      metadata: { pluginId, traceId: "trace-first" },
    };
    const existingRun = {
      id: "plugin-run",
      sessionId: "s1",
      inputId: existingInput.id,
      status: "running",
      metadata: { pluginId, traceId: "trace-first" },
    };
    const pluginCapabilities = {
      admit: vi.fn(async () => {
        throw new Error("session_plugin_capability_unavailable");
      }),
    };
    const { application } = applicationService(inventory(), {
      existingInput,
      existingRun,
      pluginCapabilities,
    });

    await expect(application.admitPrompt("s1", {
      id: existingInput.id,
      items: existingInput.items as SessionUserInputItem[],
      traceId: "trace-retry",
    })).resolves.toMatchObject({
      input: existingInput,
      run: existingRun,
    });
    expect(pluginCapabilities.admit).not.toHaveBeenCalled();
  });

  it("rejects an invalid plugin edit before closing the runtime or creating records", async () => {
    const { application, replaceLatestPrompt, agentPool, store } = applicationService(inventory());

    await expect(application.editLatestPrompt("s1", {
      id: "edited-plugin-input",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.vykor.missing",
        displayName: "Missing",
      }],
      sourceMessageId: "latest-user-message",
      traceId: "trace-edit",
    })).rejects.toThrow("session_plugin_capability_unavailable");

    expect(agentPool.close).not.toHaveBeenCalled();
    expect(replaceLatestPrompt).not.toHaveBeenCalled();
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it("writes pluginId to edited Input and Run metadata", async () => {
    const { application, replaceLatestPrompt } = applicationService(inventory());
    const items: SessionUserInputItem[] = [{
      type: "capability",
      kind: "plugin",
      pluginId,
      displayName: "Quality",
    }];

    await application.editLatestPrompt("s1", {
      id: "edited-plugin-input",
      items,
      sourceMessageId: "latest-user-message",
      metadata: { source: "desktop" },
      traceId: "trace-edit",
    });

    expect(replaceLatestPrompt).toHaveBeenCalledWith("s1", "latest-user-message", {
      id: "edited-plugin-input",
      items,
      attachments: [],
      traceId: "trace-edit",
      metadata: {
        source: "desktop",
        pluginId,
        edit: { kind: "latest_prompt", sourceMessageId: "latest-user-message" },
      },
      runMetadata: { pluginId },
    });
  });
});

function capabilityService(current: PluginCapabilityInventory): SessionPluginCapabilityService {
  return new SessionPluginCapabilityService({
    resolveInventory: async (requestedSession) => {
      expect(requestedSession).toBe(session);
      return current;
    },
  });
}

function inventory(options: {
  extraPluginId?: string;
  diagnostics?: PluginCapabilityInventory["diagnostics"];
} = {}): PluginCapabilityInventory {
  const owner = (id: string): PluginCapabilityOwner => ({
    pluginId: id,
    displayName: id,
    description: "",
    version: "1.0.0",
    scope: "user",
    origin: "native",
    skillNames: id === pluginId ? ["review"] : [],
    mcpServerIds: [],
    nativeToolEntries: [],
    agentNames: id === pluginId ? [agentId] : [],
  });
  const plugins = new Map([[pluginId, owner(pluginId)]]);
  if (options.extraPluginId) plugins.set(options.extraPluginId, owner(options.extraPluginId));
  return {
    plugins,
    skills: new Map([["review", {
      pluginId,
      path: "/plugins/quality/skills/review/SKILL.md",
    }]]),
    mcpServers: new Map(),
    nativeToolEntries: new Map(),
    agents: new Map([[agentId, { pluginId }]]),
    diagnostics: [...(options.diagnostics ?? [])],
  };
}

function applicationService(current: PluginCapabilityInventory, options: {
  sourceInput?: Record<string, any>;
  sourceRun?: Record<string, any>;
  existingInput?: Record<string, any>;
  existingRun?: Record<string, any>;
  pluginCapabilities?: Pick<SessionPluginCapabilityService, "admit">;
} = {}) {
  const store = {
    getSession: vi.fn(() => session),
    getInput: vi.fn((id) => id === options.sourceInput?.id
      ? options.sourceInput
      : id === options.existingInput?.id ? options.existingInput : undefined),
    getRun: vi.fn((id) => id === options.sourceRun?.id
      ? options.sourceRun
      : id === options.existingRun?.id ? options.existingRun : undefined),
    listRunsByInput: vi.fn(() => []),
    listMessages: vi.fn(() => [{ id: "latest-user-message", role: "user" }]),
    admitPrompt: vi.fn(),
    createRun: vi.fn(),
    appendEvent: vi.fn(),
  };
  const admitPromptAndMaybeRun = vi.fn(async (_sessionId, input) =>
    input.id === options.existingInput?.id
      ? { input: options.existingInput, run: options.existingRun }
      : {
          input: { ...input, sessionId: "s1" },
          run: { id: "r1", sessionId: "s1", inputId: input.id, metadata: input.runMetadata },
        }
  );
  const replayInput = vi.fn((inputId, input) => ({
    input: options.sourceInput,
    run: {
      id: input.id,
      sessionId: "s1",
      inputId,
      status: "pending",
      metadata: input.metadata,
    },
  }));
  const replaceLatestPrompt = vi.fn((_sessionId, _messageId, input) => ({
    input: { ...input, sessionId: "s1" },
    run: { id: "edited-run", sessionId: "s1", inputId: input.id, metadata: input.runMetadata },
  }));
  const agentPool = { configured: true, close: vi.fn(async () => {}) };
  const application = new SessionInteractionService({
    sessions: {
      get: store.getSession,
      listChildren: vi.fn(() => []),
    },
    conversations: store as never,
    runs: store as never,
    admission: {
      admitPromptAndMaybeRun,
      replayInput,
      replaceLatestPrompt,
    },
    control: {
      hasWork: vi.fn(() => false),
    } as never,
    operationRunner: { run: async (_id, work) => work() },
    agentPool: agentPool as never,
    liveChildren: {
      has: vi.fn(() => false),
      send: vi.fn(),
      interrupt: vi.fn(),
    },
    operationGate: new DaemonOperationGate(),
    pluginCapabilities: options.pluginCapabilities ?? capabilityService(current),
  });
  return {
    application,
    store,
    admitPromptAndMaybeRun,
    replayInput,
    replaceLatestPrompt,
    agentPool,
  };
}
