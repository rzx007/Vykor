import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveProjectSettings } from "@openharness/core";
import { createDefaultNodeAgent } from "@openharness/agent-runtime";

import { createDaemonAgentLoader } from "../daemon-agent.js";

describe("daemon request settings refresh", () => {
  it("keeps an explicitly cleared session prompt cleared on a warm agent", async () => {
    const session = {
      id: "cleared-prompt", cwd: "/repo", model: "model-a",
      metadata: { runtime: { model: "model-a", systemPrompt: "old session instructions" } },
    } as any;
    const createAgent = vi.fn(async () => ({
      loadHistory: () => undefined, close: async () => undefined,
    }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "model-a", systemPrompt: "old settings instructions" } as any,
      getSettingsForCwd: async () => ({ model: "model-a", systemPrompt: "new settings instructions" } as any),
      getSession: () => session,
      createAgent,
    })!;
    await loader({ session, history: [], parts: [] });
    const reader = createAgent.mock.calls[0]![0].options.requestConfigurationStore;
    expect((await reader.read()).configuration.systemPrompt).toBe("old session instructions");
    session.metadata.runtime.systemPrompt = "";
    const configuration = (await reader.read()).configuration;
    expect(configuration.systemPrompt).toBe("");
    expect(configuration.settingsPrompt).toBe("new settings instructions");
  });

  it("reads changed prompt settings without replacing a session model", async () => {
    let settings = {
      model: "settings-model", systemPrompt: "old instructions",
      workStyle: "practical", fastMode: false,
    };
    const createAgent = vi.fn(async () => ({
      loadHistory: () => undefined, close: async () => undefined,
    }) as any);
    const loader = createDaemonAgentLoader({
      settings: settings as any,
      getSettingsForCwd: async () => settings as any,
      createAgent,
    })!;
    await loader({
      session: {
        id: "prompt-settings", cwd: "/repo", model: "session-model",
        metadata: {
          runtime: { model: "session-model", systemPrompt: "old instructions" },
          runtimeDefaultFields: ["systemPrompt"],
        },
      } as any,
      history: [], parts: [],
    });
    const reader = createAgent.mock.calls[0]![0].options.requestConfigurationStore;
    settings = {
      model: "different-default", systemPrompt: "new instructions",
      workStyle: "efficient", fastMode: true,
    };
    expect((await reader.read()).configuration).toMatchObject({
      model: "session-model", settingsPrompt: "new instructions",
      workStyle: "efficient", fastMode: true,
    });
    expect((await reader.read()).configuration.systemPrompt).toBeUndefined();
  });

  it("reads a changed default maxTurns for a warm session", async () => {
    let maxTurns = 1;
    const createAgent = vi.fn(async () => ({
      loadHistory: () => undefined, close: async () => undefined,
    }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "model-a", maxTurns: 1 } as any,
      getSettingsForCwd: async () => ({ model: "model-a", maxTurns } as any),
      createAgent,
    })!;
    await loader({
      session: {
        id: "max-turns", cwd: "/repo", model: "model-a",
        metadata: {
          runtime: { model: "model-a", maxTurns: 1 },
          runtimeDefaultFields: ["maxTurns"],
        },
      } as any,
      history: [], parts: [],
    });
    const reader = createAgent.mock.calls[0]![0].options.requestConfigurationStore;
    expect((await reader.read()).configuration.maxTurns).toBe(1);
    maxTurns = 2;
    expect((await reader.read()).configuration.maxTurns).toBe(2);
  });

  it("uses a project settings edit for the next model request in the same run", async () => {
    const project = mkdtempSync(join(tmpdir(), "openharness-effort-run-"));
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const requests: Array<{ effort?: string; system?: string }> = [];
    const client = {
      async *streamMessage(params: { reasoningEffort?: string; system?: string }) {
        requests.push({ effort: params.reasoningEffort, system: params.system });
        if (requests.length === 1) {
          started();
          await held;
          yield {
            type: "tool_use_start" as const,
            toolUse: { type: "tool_use" as const, id: "echo", name: "Echo", input: {} },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta" as const, delta: "done" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    let agent: Awaited<ReturnType<typeof createDefaultNodeAgent>> | undefined;
    try {
      await saveProjectSettings({
        effort: "low", workStyle: "practical", fastMode: false,
        systemPrompt: "old project instructions",
      }, project);
      const loader = createDaemonAgentLoader({
        getSettingsForCwd: (cwd) => loadSettings(undefined, { includeProject: true, projectRoot: cwd }),
        createAgent: async ({ options }) => {
          agent = await createDefaultNodeAgent({ ...options, client });
          return agent;
        },
        tools: async () => [{
          name: "Echo", description: "Echoes", inputSchema: {},
          execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        }],
      })!;
      agent = await loader({
        session: {
          id: "session-live-effort", cwd: project, model: "model-a",
          metadata: {
            runtime: { model: "model-a", permissionMode: "full_auto" },
            runtimeDefaultFields: ["effort", "systemPrompt"],
          },
        } as any,
        history: [], parts: [],
      });
      const running = agent.runMessage("use Echo");
      await firstStarted;
      await saveProjectSettings({
        effort: "high", workStyle: "efficient", fastMode: true,
        systemPrompt: "new project instructions",
      }, project);
      release();
      await running;
      expect(requests.map((item) => item.effort)).toEqual(["low", "high"]);
      expect(requests[0]!.system).toContain("Effort: low");
      expect(requests[1]!.system).toContain("Effort: high");
      expect(requests[0]!.system).toContain("old project instructions");
      expect(requests[1]!.system).toContain("new project instructions");
      expect(requests[1]!.system).toContain("# Work Style: Efficient");
      expect(requests[1]!.system).toContain("Fast mode is enabled");
    } finally {
      release?.();
      await agent?.close();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("applies a changed project settings file only to that project's session", async () => {
    const projectA = mkdtempSync(join(tmpdir(), "openharness-settings-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "openharness-settings-b-"));
    try {
      await saveProjectSettings({ effort: "low" }, projectA);
      await saveProjectSettings({ effort: "medium" }, projectB);
      const readers = new Map<string, any>();
      const loader = createDaemonAgentLoader({
        getSettingsForCwd: (cwd) => loadSettings(undefined, { includeProject: true, projectRoot: cwd }),
        createAgent: async ({ session, options }) => {
          readers.set(session.id, options.requestConfigurationStore);
          return { loadHistory: () => undefined, close: async () => undefined } as any;
        },
      })!;
      for (const [id, cwd] of [["a", projectA], ["b", projectB]] as const) {
        await loader({
          session: {
            id, cwd, model: "model-a",
            metadata: { runtime: { model: "model-a" }, runtimeDefaultFields: ["effort"] },
          } as any,
          history: [], parts: [],
        });
      }
      await saveProjectSettings({ effort: "high" }, projectA);
      expect((await readers.get("a").read()).configuration.effort).toBe("high");
      expect((await readers.get("b").read()).configuration.effort).toBe("medium");
    } finally {
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("follows a changed default effort on the next request boundary", async () => {
    let effort = "low";
    const createAgent = vi.fn(async () => ({
      loadHistory: () => undefined,
      close: async () => undefined,
    }) as any);
    const session = {
      id: "session-default-effort",
      cwd: "/repo",
      model: "model-a",
      metadata: {
        runtime: { model: "model-a", provider: "provider-a" },
        runtimeDefaultFields: ["effort"],
      },
    } as any;
    const loader = createDaemonAgentLoader({
      settings: { model: "model-a", effort: "low" } as any,
      getSettingsForCwd: async () => ({ model: "model-a", effort } as any),
      createAgent,
    })!;
    await loader({ session, history: [], parts: [] });
    const reader = createAgent.mock.calls[0]![0].options.requestConfigurationStore;

    expect((await reader.read()).configuration.effort).toBe("low");
    effort = "high";
    expect((await reader.read()).configuration.effort).toBe("high");
  });

  it("keeps the last good effort when the settings file temporarily fails to load", async () => {
    let invalid = false;
    let effort = "high";
    const onSettingsReloadError = vi.fn();
    const createAgent = vi.fn(async () => ({
      loadHistory: () => undefined,
      close: async () => undefined,
    }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "model-a", effort: "low" } as any,
      getSettingsForCwd: async () => {
        if (invalid) throw new SyntaxError("invalid settings JSON");
        return { model: "model-a", effort } as any;
      },
      onSettingsReloadError,
      createAgent,
    })!;
    await loader({
      session: {
        id: "session-invalid-file", cwd: "/repo", model: "model-a",
        metadata: { runtime: { model: "model-a" }, runtimeDefaultFields: ["effort"] },
      } as any,
      history: [], parts: [],
    });
    const reader = createAgent.mock.calls[0]![0].options.requestConfigurationStore;
    expect((await reader.read()).configuration.effort).toBe("high");
    invalid = true;
    expect((await reader.read()).configuration.effort).toBe("high");
    expect((await reader.read()).configuration.effort).toBe("high");
    expect(onSettingsReloadError).toHaveBeenCalledTimes(1);
    invalid = false;
    effort = "max";
    expect((await reader.read()).configuration.effort).toBe("max");
  });
});
