import { describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@vykor/protocol";

import { createInitialClientState } from "../../state/reducer.js";
import {
  LOCAL_COMMAND_DETAILS,
  dispatchSessionCommand,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "../session-commands.js";
import type { SessionCommandClient } from "../session-commands.js";
import type { CommandCatalogEntry, PluginInfo } from "../../types/index.js";

const agentJob: JobSnapshot = {
  id: "agent-1",
  kind: "agent",
  label: "Review the change",
  ownerSession: "s1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/tmp/project",
  startedAt: 10,
  updatedAt: 20,
};

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    ...agentJob,
    ...overrides,
    capabilities: { ...agentJob.capabilities, ...overrides.capabilities },
  };
}

function fakeClient(overrides: Record<string, unknown> = {}): SessionCommandClient {
  const method = (name: string, fallback: (...args: never[]) => unknown = vi.fn()) =>
    (overrides[name] ?? fallback) as never;
  return {
    protocol: {
      health: method("health", vi.fn(async () => ({ ok: true, version: "1.2.3" }))),
    },
    system: {
      getSettings: method("getSettings", vi.fn(async () => ({}))),
      patchSettings: method("patchSettings"),
      getSessionMcp: method("getSessionMcp", vi.fn(async () => [])),
      listMemory: method("listMemory", vi.fn(async () => ({ directory: "/memory", entries: [] }))),
      getMemory: method("getMemory"),
      addMemory: method("addMemory"),
      removeMemory: method("removeMemory"),
      getContextPreview: method("getContextPreview"),
      getContextStatus: method("getContextStatus"),
      getContextUsage: method("getContextUsage"),
      startDream: method("startDream"),
      getProfileStatus: method("getProfileStatus"),
      initProfile: method("initProfile"),
      listOutputStyles: method("listOutputStyles"),
    },
    providers: { listProviders: method("listProviders") },
    auth: {
      getStatus: method("getAuthStatus", vi.fn(async () => null)),
      login: method("authLogin"),
      logout: method("authLogout"),
    },
    projects: { init: method("initProject") },
    plugins: {
      list: method("listPlugins"),
      enable: method("enablePlugin"),
      disable: method("disablePlugin"),
      reload: method("reloadPlugins"),
    },
    development: {
      listAgentPersonas: method("listAgentPersonas"),
      listHooks: method("listHooks"),
      getGitDiff: method("getGitDiff"),
      getGitBranch: method("getGitBranch"),
      getGitStatus: method("getGitStatus"),
      gitCommit: method("gitCommit"),
    },
    sessions: {
      update: method("updateSession"),
      compact: method("compactSession"),
      rewind: method("rewindSession"),
      remember: method("rememberSession"),
      export: method("exportSession"),
      getUsage: method("getSessionUsage"),
    },
    jobs: {
      list: method("listJobs", vi.fn(async () => [])),
      createBackgroundShell: method("createBackgroundShell"),
      read: method("readJob"),
      cancel: method("cancelJob"),
    },
  };
}

function host(partial: {
  client?: SessionCommandClient;
  emit?: (text: string) => void;
  commandCatalog?: CommandCatalogEntry[];
  getRuntimeDiagnostics?: () => {
    runtime?: string;
    platform?: string;
    architecture?: string;
  };
} = {}) {
  const emitted: string[] = [];
  return {
    emitted,
    host: {
      client: partial.client ?? fakeClient(),
      cwd: "/tmp/project",
      commandCatalog: partial.commandCatalog ?? [],
      clientState: createInitialClientState(),
      busy: false,
      getRuntimeDiagnostics: partial.getRuntimeDiagnostics,
      emit: partial.emit ?? ((text: string) => {
        emitted.push(text);
      }),
    },
  };
}

describe("parseSlashLine", () => {
  it("parses command name and args", () => {
    expect(parseSlashLine("/help")).toEqual({ name: "/help", args: "" });
    expect(parseSlashLine("  /provider openai  ")).toEqual({ name: "/provider", args: "openai" });
    expect(parseSlashLine("hello")).toBeNull();
  });
});

describe("mergeCommandDetails", () => {
  it("prefers local details over catalog", () => {
    const merged = mergeCommandDetails([
      { name: "/theme", kind: "session", source: "builtin", description: "Catalog theme" },
      { name: "/help", kind: "session", source: "builtin", description: "Show help" },
    ]);
    const theme = merged.find((entry) => entry.name === "/theme");
    const help = merged.find((entry) => entry.name === "/help");
    const workflow = merged.find((entry) => entry.name === "/workflow");
    const workflows = merged.find((entry) => entry.name === "/workflows");
    expect(theme?.description).toBe(
      LOCAL_COMMAND_DETAILS.find((entry) => entry.name === "/theme")?.description,
    );
    expect(help?.description).toBe("Show help");
    expect(workflow?.description).toBe("Open Jobs panel with Workflow details");
    expect(workflows?.description).toBe("Open Jobs panel with Workflow details");
  });
});

describe("resolveSessionCwd", () => {
  it("prefers status cwd, then daemon cwd, then fallback", () => {
    expect(resolveSessionCwd({ statusCwd: "/a", daemonCwd: "/b", fallback: "/c" })).toBe("/a");
    expect(resolveSessionCwd({ statusCwd: "", daemonCwd: "/b", fallback: "/c" })).toBe("/b");
    expect(resolveSessionCwd({ fallback: "/c" })).toBe("/c");
  });
});

describe("dispatchSessionCommand", () => {
  it("shows reload validation failures and permission recovery steps without claiming activation", async () => {
    const plugin: PluginInfo = {
      identity: { id: "example.text-inspector", name: "text-inspector", version: "1.0.0" },
      origin: "native", scope: "user", enabled: true,
      installation: "invalid", activation: "reload-required", inventory: {},
      runtimeStatus: { state: "failed", code: "plugin_installation_permissions_mismatch", message: "插件权限需要重新批准。", action: "approve" },
      permissions: { requested: [], approved: [], missing: [] },
      diagnostics: [{ severity: "error", phase: "activate", code: "plugin_installation_permissions_mismatch", message: "Actual permissions differ from the installed permission request" }],
    };
    const { host: h, emitted } = host({ client: fakeClient({
      async reloadPlugins() {
        return {
          message: "Plugins rediscovered; session runtimes will reload on next use.",
          warnings: [],
          plugins: [plugin],
        };
      },
    }) });
    await dispatchSessionCommand({ name: "/reload-plugins", args: "" }, h);
    const text = emitted.join("\n");
    expect(text).toContain("invalid");
    expect(text).toContain("plugin_installation_permissions_mismatch");
    expect(text).toContain("Actual permissions differ");
    expect(text).toContain("vk plugin link");
    expect(text).toContain("--approve");
    expect(text).toContain("next use");
    expect(text).not.toContain("Reloaded plugins:");
  });

  it("keeps reload warnings even when no plugins are discovered", async () => {
    const { host: h, emitted } = host({ client: fakeClient({
      async reloadPlugins() { return { plugins: [], warnings: ["Legacy plugin requires reinstall"], message: "Runtimes will reload on next use." }; },
    }) });
    await dispatchSessionCommand({ name: "/reload-plugins", args: "" }, h);
    expect(emitted.join("\n")).toContain("Legacy plugin requires reinstall");
  });

  it("emits Available commands for /help", async () => {
    const { host: h, emitted } = host({
      commandCatalog: [
        { name: "/help", kind: "session", source: "builtin", description: "Show help" },
      ],
    });
    const outcome = await dispatchSessionCommand({ name: "/help", args: "" }, h);
    expect(outcome).toBe("handled");
    expect(emitted[0]).toContain("Available commands:");
    expect(emitted[0]).toContain("/help");
  });

  it("calls health and emits for /version", async () => {
    const client = fakeClient();
    const { host: h, emitted } = host({ client });
    const outcome = await dispatchSessionCommand({ name: "/version", args: "" }, h);
    expect(outcome).toBe("handled");
    expect(client.protocol.health).toHaveBeenCalledOnce();
    expect(emitted[0]).toBe("Vykor v1.2.3");
  });

  it("presents read-only command output when a presentation surface is available", async () => {
    const { host: h, emitted } = host();
    const presented: Array<{ title: string; content: string }> = [];
    Object.assign(h, {
      sessionId: "s1",
      model: "m",
      statusSessionId: "s1",
      permissionMode: "default",
      present: (title: string, content: string) => {
        presented.push({ title, content });
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/status", args: "" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(presented[0]?.title).toBe("Status");
    expect(presented[0]?.content).toContain("Session status:");
  });

  it("routes cache-first read commands through the presentation cache host", async () => {
    const getContextPreview = vi.fn(async () => "CONTEXT");
    const client = fakeClient({ getContextPreview });
    const { host: h, emitted } = host({ client });
    const reads: Array<{ key: string; title: string; load: () => Promise<string> }> = [];
    Object.assign(h, {
      present: vi.fn(),
      cacheFirstRead: (request: { key: string; title: string; load: () => Promise<string> }) => {
        reads.push(request);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/context", args: "" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(getContextPreview).not.toHaveBeenCalled();
    expect(reads[0]?.key).toBe("context:/tmp/project");
    expect(reads[0]?.title).toBe("Context");
    await expect(reads[0]!.load()).resolves.toBe("CONTEXT");
    expect(getContextPreview).toHaveBeenCalledWith({ cwd: "/tmp/project" });
  });

  it("routes /context status to the context status reader", async () => {
    const getContextStatus = vi.fn(async () => "STATUS TABLE");
    const client = fakeClient({ getContextStatus });
    const { host: h, emitted } = host({ client });
    const reads: Array<{ key: string; title: string; load: () => Promise<string> }> = [];
    Object.assign(h, {
      present: vi.fn(),
      cacheFirstRead: (request: { key: string; title: string; load: () => Promise<string> }) => {
        reads.push(request);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/context", args: "status" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(reads[0]?.key).toBe("context:/tmp/project:status");
    await expect(reads[0]!.load()).resolves.toBe("STATUS TABLE");
    expect(getContextStatus).toHaveBeenCalledWith({ cwd: "/tmp/project" });
  });

  it("routes /context usage through the presentation reader", async () => {
    const getContextUsage = vi.fn(async () => ({
      snapshot: { source: "static_only" },
      report: "USAGE REPORT TEXT",
    }));
    const client = fakeClient({ getContextUsage });
    const { host: h, emitted } = host({ client });
    const reads: Array<{ key: string; title: string; load: () => Promise<string> }> = [];
    Object.assign(h, {
      sessionId: "s1",
      present: vi.fn(),
      cacheFirstRead: (request: { key: string; title: string; load: () => Promise<string> }) => {
        reads.push(request);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/context", args: "usage" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(reads[0]?.key).toBe("context:/tmp/project:usage:s1");
    await expect(reads[0]!.load()).resolves.toBe("USAGE REPORT TEXT");
    expect(getContextUsage).toHaveBeenCalledWith({ cwd: "/tmp/project", sessionId: "s1" });
  });

  it("lists Jobs through the unified read surface", async () => {
    const listJobs = vi.fn(async () => [agentJob]);
    const { host: h, emitted } = host({ client: fakeClient({ listJobs }) });
    const presented: Array<{ title: string; content: string }> = [];
    Object.assign(h, {
      sessionId: "s1",
      present: (title: string, content: string) => presented.push({ title, content }),
    });

    await expect(dispatchSessionCommand({ name: "/jobs", args: "" }, h)).resolves.toBe("handled");

    expect(listJobs).toHaveBeenCalledWith({
      sessionId: "s1",
      includeFinished: true,
      limit: 100,
    });
    expect(emitted).toHaveLength(0);
    expect(presented).toContainEqual({
      title: "Jobs",
      content: "Jobs (1):\n\n  agent-1 [running] agent: Review the change",
    });
  });

  it("reads a normalized Job snapshot and its output", async () => {
    const readJob = vi.fn(async () => ({
      snapshot: agentJob,
      text: "review output",
      cursor: 13,
      truncated: false,
    }));
    const { host: h, emitted } = host({ client: fakeClient({ readJob }) });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/jobs", args: "show agent-1" }, h))
      .resolves.toBe("handled");

    expect(readJob).toHaveBeenCalledWith("agent-1", { sessionId: "s1" });
    expect(emitted[0]).toContain("Job: agent-1");
    expect(emitted[0]).toContain("Kind:          agent");
    expect(emitted[0]).toContain("Status:        running");
    expect(emitted[0]).toContain("Output:\nreview output");
  });

  it("cancels a Job with an explicit slash-command reason", async () => {
    const cancelJob = vi.fn(async () => job({ status: "killed", updatedAt: 30 }));
    const { host: h, emitted } = host({ client: fakeClient({ cancelJob }) });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/jobs", args: "cancel agent-1" }, h))
      .resolves.toBe("handled");

    expect(cancelJob).toHaveBeenCalledWith("agent-1", {
      sessionId: "s1",
      reason: "Cancelled from slash command",
    });
    expect(emitted.at(-1)).toContain("killed");
  });

  it("starts a producer-specific background shell and reports its Job ID", async () => {
    const shell = job({ id: "shell-1", kind: "shell", label: "pnpm test" });
    const createBackgroundShell = vi.fn(async () => ({ jobId: shell.id, snapshot: shell }));
    const { host: h, emitted } = host({ client: fakeClient({ createBackgroundShell }) });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/background", args: "pnpm test" }, h))
      .resolves.toBe("handled");

    expect(createBackgroundShell).toHaveBeenCalledWith({ sessionId: "s1", command: "pnpm test" });
    expect(emitted.at(-1)).toBe("Background shell started: shell-1. Use /jobs to inspect it.");
  });

  it("emits the new Jobs and background usage for malformed commands", async () => {
    const { host: h, emitted } = host();
    Object.assign(h, { sessionId: "s1" });

    await dispatchSessionCommand({ name: "/jobs", args: "show" }, h);
    await dispatchSessionCommand({ name: "/jobs", args: "stop agent-1" }, h);
    await dispatchSessionCommand({ name: "/background", args: "" }, h);

    expect(emitted).toEqual([
      "Usage: /jobs [list | show ID | cancel ID]",
      "Usage: /jobs [list | show ID | cancel ID]",
      "Usage: /background <command>",
    ]);
  });

  it("does not retain the removed /tasks slash-command alias", async () => {
    const { host: h } = host();
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/tasks", args: "" }, h))
      .resolves.toBe("unhandled");
  });

  it("counts Jobs in session stats without background-task terminology", async () => {
    const listJobs = vi.fn(async () => [agentJob, job({ id: "shell-1", kind: "shell" })]);
    const client = fakeClient({
      listJobs,
      listMemory: vi.fn(async () => ({ directory: "/memory", entries: [] })),
      getSettings: vi.fn(async () => ({})),
    });
    const { host: h, emitted } = host({ client });
    Object.assign(h, { sessionId: "s1" });

    await dispatchSessionCommand({ name: "/stats", args: "" }, h);

    expect(listJobs).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true, limit: 100 });
    expect(emitted.at(-1)).toContain("- jobs: 2");
    expect(emitted.at(-1)).not.toContain("background_tasks");
  });

  it("reports unavailable Jobs in session stats instead of an authoritative zero", async () => {
    const client = fakeClient({
      listJobs: vi.fn(async () => {
        throw new Error("jobs unavailable");
      }),
      listMemory: vi.fn(async () => ({ directory: "/memory", entries: [] })),
      getSettings: vi.fn(async () => ({})),
    });
    const { host: h, emitted } = host({ client });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/stats", args: "" }, h)).resolves.toBe("handled");

    expect(emitted.at(-1)).toContain("- jobs: unavailable (jobs unavailable)");
    expect(emitted.at(-1)).not.toContain("- jobs: 0");
  });

  it("lists only Agent Jobs for /agents", async () => {
    const listJobs = vi.fn(async () => [agentJob]);
    const { host: h, emitted } = host({ client: fakeClient({ listJobs }) });
    Object.assign(h, { sessionId: "s1" });

    await dispatchSessionCommand({ name: "/agents", args: "" }, h);

    expect(listJobs).toHaveBeenCalledWith({
      sessionId: "s1",
      kinds: ["agent"],
      includeFinished: true,
      limit: 100,
    });
    expect(emitted.at(-1)).toContain("Agent Jobs (1):");
  });

  it("keeps MCP failures independent while /doctor reports Jobs", async () => {
    const listJobs = vi.fn(async () => [agentJob]);
    const client = fakeClient({
      listJobs,
      getSettings: vi.fn(async () => ({})),
      getAuthStatus: vi.fn(async () => ({
        codex: { configured: false, state: "missing", source: "/tmp/auth.json" },
        storedProviders: [],
        envProviders: [],
      })),
      listMemory: vi.fn(async () => ({ directory: "/memory", entries: [] })),
      getSessionMcp: vi.fn(async () => {
        throw new Error("MCP unavailable");
      }),
    });
    const { host: h, emitted } = host({
      client,
      getRuntimeDiagnostics: () => ({
        runtime: "Node v22-test",
        platform: "test-os",
        architecture: "test-arch",
      }),
    });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/doctor", args: "" }, h)).resolves.toBe("handled");

    expect(listJobs).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true, limit: 100 });
    expect(emitted.at(-1)).toContain("Jobs:           1");
    expect(emitted.at(-1)).toContain("Runtime:        Node v22-test");
    expect(emitted.at(-1)).toContain("Platform:       test-os test-arch");
  });

  it("does not assume a Node runtime when /doctor host diagnostics are absent", async () => {
    const client = fakeClient({
      listJobs: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({})),
      getAuthStatus: vi.fn(async () => null as never),
      listMemory: vi.fn(async () => ({ directory: "/memory", entries: [] })),
      getSessionMcp: vi.fn(async () => []),
    });
    const { host: h, emitted } = host({ client });

    await expect(dispatchSessionCommand({ name: "/doctor", args: "" }, h)).resolves.toBe("handled");

    expect(emitted.at(-1)).toContain("Runtime:        (not provided by this host)");
    expect(emitted.at(-1)).toContain("Platform:       (not provided by this host)");
  });

  it("reports unavailable Jobs in /doctor instead of an authoritative zero", async () => {
    const client = fakeClient({
      listJobs: vi.fn(async () => {
        throw new Error("jobs unavailable");
      }),
      getSettings: vi.fn(async () => ({})),
      getAuthStatus: vi.fn(async () => null as never),
      listMemory: vi.fn(async () => ({ directory: "/memory", entries: [] })),
      getSessionMcp: vi.fn(async () => []),
    });
    const { host: h, emitted } = host({ client });
    Object.assign(h, { sessionId: "s1" });

    await expect(dispatchSessionCommand({ name: "/doctor", args: "" }, h)).resolves.toBe("handled");

    expect(emitted.at(-1)).toContain("Jobs:           unavailable (jobs unavailable)");
    expect(emitted.at(-1)).not.toContain("Jobs:           0");
  });

  it("presents dream receipts as Jobs", async () => {
    const startDream = vi.fn(async () => ({ taskId: "dream-1" }));
    const { host: h, emitted } = host({ client: fakeClient({ startDream }) });
    Object.assign(h, { sessionId: "s1" });

    await dispatchSessionCommand({ name: "/dream", args: "" }, h);

    expect(emitted.at(-1)).toBe("Dream started as Job dream-1. Use /jobs to inspect it.");
  });

  it("returns unhandled for unknown non-local commands", async () => {
    const { host: h, emitted } = host();
    const outcome = await dispatchSessionCommand({ name: "/not-a-real-cmd", args: "" }, h);
    expect(outcome).toBe("unhandled");
    expect(emitted).toHaveLength(0);
  });

  it("returns local_ui for LOCAL /theme", async () => {
    const { host: h } = host();
    const outcome = await dispatchSessionCommand({ name: "/theme", args: "dark" }, h);
    expect(outcome).toBe("local_ui");
  });

  it("returns local_ui for LOCAL /models", async () => {
    const { host: h } = host();
    const outcome = await dispatchSessionCommand({ name: "/models", args: "" }, h);
    expect(outcome).toBe("local_ui");
  });

  it("patches session runtime permissionMode for /plan", async () => {
    const updateSession = vi.fn(async (_id: string, input: { metadata?: Record<string, unknown> }) => ({
      id: "s1",
      cwd: "/tmp",
      title: "TUI",
      model: "m",
      status: "idle",
      metadata: input.metadata ?? {},
      createdAt: 1,
      updatedAt: 2,
    }));
    const patches: Array<Record<string, unknown>> = [];
    const client = fakeClient({ updateSession });
    const { host: h, emitted } = host({ client });
    Object.assign(h, {
      sessionId: "s1",
      patchStatus: (patch: Record<string, unknown>) => {
        patches.push(patch);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/plan", args: "on" }, h);

    expect(outcome).toBe("handled");
    expect(updateSession).toHaveBeenCalledWith("s1", {
      metadata: { runtime: { permissionMode: "plan" } },
    });
    expect(patches).toEqual([{ permission_mode: "plan" }]);
    expect(emitted[0]).toBe("Permission mode: plan");
  });

  it("toggles showReasoning with no argument", async () => {
    const patchSettings = vi.fn(async () => ({}));
    const { host: h, emitted } = host({
      client: fakeClient({
        getSettings: async () => ({ showReasoning: false }),
        patchSettings,
      }),
    });

    await dispatchSessionCommand({ name: "/reasoning", args: "" }, h);

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: true });
    expect(emitted.join("\n")).toContain("Reasoning: ON");
  });

  it("accepts an explicit off argument", async () => {
    const patchSettings = vi.fn(async () => ({}));
    const { host: h } = host({
      client: fakeClient({
        getSettings: async () => ({ showReasoning: true }),
        patchSettings,
      }),
    });

    await dispatchSessionCommand({ name: "/reasoning", args: "off" }, h);

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: false });
  });
});
