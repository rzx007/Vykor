import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";

import {
  createVykorRuntime,
  resolveAutoApproveTools,
  resolveCustomProviderRuntime,
  resolveEffectiveAllowedTools,
  resolveRuntimeModel,
} from "./default-runtime.js";
import { LOCAL_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "@vykor/permissions";
import type { Settings, ToolDefinition } from "@vykor/core";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import { createAgentWorkspaceBinding } from "./agent-composition.js";
import { createRunCapabilityView } from "./run-capability-view.js";

it("rebuilds the next request prompt from changed file-backed settings", async () => {
  const prompts: string[] = [];
  let configuration = {
    revision: 0,
    configuration: {
      model: "model-a", workStyle: "practical" as const,
      fastMode: false, settingsPrompt: "old instructions",
    },
  };
  const runtime = await createVykorRuntime({
    settings: {
      ...BASE_SETTINGS,
      systemPrompt: "old instructions",
      workStyle: "practical",
      fastMode: false,
      sandbox: { enabled: false },
    },
    configuration: {
      client: {
        async *streamMessage(input) {
          prompts.push(String(input.system));
          yield { type: "complete" as const, stopReason: "end_turn" };
        },
      },
    },
    requestConfigurationStore: { read: async () => configuration },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("first")) { /* consume */ }
    configuration = {
      revision: 1,
      configuration: {
        model: "model-a", workStyle: "efficient" as const,
        fastMode: true, settingsPrompt: "new instructions",
      },
    };
    for await (const _ of runtime.queryEngine.submitMessage("second")) { /* consume */ }
    expect(prompts[0]).toContain("# Work Style: Practical");
    expect(prompts[0]).toContain("old instructions");
    expect(prompts[1]).toContain("# Work Style: Efficient");
    expect(prompts[1]).toContain("Fast mode is enabled");
    expect(prompts[1]).toContain("new instructions");
    expect(prompts[1]).not.toContain("old instructions");
  } finally {
    await runtime.close();
  }
});

it("rebuilds the prompt when a warm session explicitly clears its override", async () => {
  const prompts: string[] = [];
  let sessionPrompt = "old session instructions";
  let settingsPrompt = "old settings instructions";
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, systemPrompt: settingsPrompt, sandbox: { enabled: false } },
    configuration: {
      systemPrompt: sessionPrompt,
      client: {
        async *streamMessage(input) {
          prompts.push(String(input.system));
          yield { type: "complete" as const, stopReason: "end_turn" };
        },
      },
    },
    requestConfigurationStore: { read: async () => ({
      revision: 0,
      configuration: { model: "model-a", systemPrompt: sessionPrompt, settingsPrompt },
    }) },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("first")) { /* consume */ }
    sessionPrompt = "";
    settingsPrompt = "new settings instructions";
    for await (const _ of runtime.queryEngine.submitMessage("second")) { /* consume */ }
    expect(prompts[0]).toContain("old session instructions");
    expect(prompts[1]).toContain("new settings instructions");
    expect(prompts[1]).not.toContain("old session instructions");
  } finally {
    await runtime.close();
  }
});

it("keeps an explicit Agent fastMode over its initial settings default", async () => {
  let prompt = "";
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, fastMode: false, sandbox: { enabled: false } },
    configuration: {
      fastMode: true,
      client: {
        async *streamMessage(input) {
          prompt = String(input.system);
          yield { type: "complete" as const, stopReason: "end_turn" };
        },
      },
    },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("hello")) { /* consume */ }
    expect(prompt).toContain("Fast mode is enabled");
  } finally {
    await runtime.close();
  }
});

it.each([undefined, "Custom root instructions"])("lists only the current View Agent names and descriptions with custom prompt=%s", async (systemPrompt) => {
  const prompts: string[] = [];
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, sandbox: { enabled: false } },
    configuration: { systemPrompt, client: { async *streamMessage(input) {
      prompts.push(String(input.system));
      yield { type: "complete" as const, stopReason: "end_turn" as const };
    } } },
  });
  const sources = { toolRegistry: runtime.toolRegistry, pluginIds: new Set(["selected", "other"]), agents: [
    { ownerPluginId: "selected", definition: { name: "selected:review", description: "Trusted review description", systemPrompt: "SECRET selected body" } },
    { ownerPluginId: "other", definition: { name: "other:hidden", description: "Hidden description", systemPrompt: "SECRET other body" } },
  ] };
  try {
    for (const owner of ["selected", undefined]) {
      const capabilityView = createRunCapabilityView(sources, owner);
      const execution = { capabilityView, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {} } as any;
      for await (const _ of runtime.queryEngine.submitMessage("review", { execution })) { /* consume */ }
    }
    expect(prompts[0]).toContain("selected:review");
    expect(prompts[0]).toContain("Trusted review description");
    expect(prompts[0]).not.toContain("other:hidden");
    expect(prompts.join("\n")).not.toContain("SECRET");
    expect(prompts[1]).not.toContain("selected:review");
    if (systemPrompt) expect(prompts[0]).toContain(systemPrompt);
  } finally { await runtime.close(); }
});

function testTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {},
    async execute() {
      return { content: [] };
    },
  };
}

function wslEnvironment(networkMode = "bridge"): ExecutionEnvironmentHandle {
  return {
    info: {
      kind: "wsl",
      hostOs: "Windows",
      executionOs: "Linux",
      shell: "/bin/sh",
      shellDialect: "posix",
      pathStyle: "posix",
      cwd: "/mnt/d/repo",
      homeDir: "/home",
      tempDir: "/tmp",
      mounts: [{ path: "/workspace", mode: "rw", purpose: "workspace" }],
      networkMode,
      limitations: [],
    },
    workspace: { kind: "wsl", hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" },
    process: {} as never,
    files: {} as never,
    paths: {} as never,
    release: vi.fn(async () => {}),
  };
}

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("resolveAutoApproveTools", () => {
  const base = { permission: { mode: "default" } } as Settings;
  const withSettings = {
    permission: { mode: "default", autoApproveTools: ["TodoWrite"] },
  } as Settings;

  it("无任何来源 → undefined(checker 默认行为)", () => {
    expect(resolveAutoApproveTools(base, {})).toBeUndefined();
  });

  it("settings.permission.autoApproveTools 接线(此前被忽略)", () => {
    expect(resolveAutoApproveTools(withSettings, {})).toEqual(["TodoWrite"]);
  });

  it("autoApproveReadOnly 只注入非本地只读工具(channels serve 无头模式)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveReadOnly: true }));
    expect(tools.has("Read")).toBe(false);
    expect(tools.has("Glob")).toBe(false);
    expect(tools.has("Grep")).toBe(false);
    expect(tools.has("Lsp")).toBe(false);
    expect(tools.has("JobList")).toBe(true);
    expect(tools.has("WebFetch")).toBe(true);
    expect(tools.has("Write")).toBe(false);
    expect(tools.has("Shell")).toBe(false);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size);
  });

  it("overrides.autoApproveTools 显式列表合并(channels serve 收窄集)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveTools: ["Read", "Glob"] }));
    expect(tools).toEqual(new Set(["Read", "Glob"]));
  });

  it("settings 显式本地只读授权与 readOnly 合并", () => {
    const tools = new Set(
      resolveAutoApproveTools(
        { permission: { mode: "default", autoApproveTools: ["TodoWrite", "Read"] } } as Settings,
        { autoApproveReadOnly: true },
      ),
    );
    expect(tools.has("TodoWrite")).toBe(true);
    expect(tools.has("Read")).toBe(true);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size + 2);
  });

  it("does not implicitly auto-approve an overridden read-only tool", () => {
    expect(
      resolveAutoApproveTools(
        base,
        { autoApproveReadOnly: true },
        new Set(["WebSearch", "JobList"]),
      ),
    ).not.toContain("WebFetch");
    expect(
      resolveAutoApproveTools(
        base,
        { autoApproveReadOnly: true, autoApproveTools: ["WebFetch"] },
        new Set(["WebSearch", "JobList"]),
      ),
    ).toContain("WebFetch");
  });
});
describe("resolveRuntimeModel", () => {
  it("prefers CLI override model over settings model", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, { model: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });

  it("falls back to settings model when no override is provided", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, {})).toBe(BASE_SETTINGS.model);
  });
});

describe("resolveCustomProviderRuntime", () => {
  it("resolves a selected custom provider as an OpenAI-compatible endpoint", () => {
    const settings: Settings = {
      ...BASE_SETTINGS,
      provider: "office-gateway",
      customProviders: [
        {
          id: "office-gateway",
          displayName: "Office Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai",
          models: [{ id: "team-model", displayName: "Team Model" }],
          headers: { "X-Tenant": "desktop" },
        },
      ],
    };

    expect(resolveCustomProviderRuntime(settings, "office-gateway")).toEqual({
      backendType: "openai_compat",
      baseURL: "https://gateway.example/v1",
      headers: { "X-Tenant": "desktop" },
    });
  });

  it("does not resolve a provider that is not custom", () => {
    expect(resolveCustomProviderRuntime(BASE_SETTINGS, "anthropic")).toBeUndefined();
  });
});

describe("resolveEffectiveAllowedTools", () => {
  it("intersects host ceiling with role tools", () => {
    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read", "Agent"],
      roleAllowedTools: ["*", "Shell", "Edit"],
      knownToolNames: ["Read", "Agent", "Shell", "Edit"],
    })).toEqual({ kind: "only", names: new Set(["Read", "Agent"]) });

    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read", "Agent", "Workflow"],
      roleAllowedTools: ["Agent", "Workflow"],
      knownToolNames: ["Read", "Agent", "Workflow"],
    })).toEqual({ kind: "only", names: new Set(["Agent", "Workflow"]) });

    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read"],
      roleAllowedTools: ["Shell"],
      knownToolNames: ["Read", "Shell"],
    })).toEqual({ kind: "only", names: new Set() });
  });

  it("represents an unrestricted limit explicitly", () => {
    expect(resolveEffectiveAllowedTools({
      knownToolNames: ["Read", "Shell"],
    })).toEqual({ kind: "all" });
  });
});

describe("createVykorRuntime tool visibility", () => {
  it("uses a projectless managed cwd as the WSL workspace root", () => {
    expect(createAgentWorkspaceBinding("D:\\Documents\\Vykor\\2026-09-07\\x1", "wsl"))
      .toEqual({
        kind: "wsl",
        hostRoot: "D:\\Documents\\Vykor\\2026-09-07\\x1",
        executionRoot: "/mnt/d/Documents/Vykor/2026-09-07/x1",
      });
  });

  it("keeps environment tools including TerminalOpen in WSL", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      executionEnvironment: wslEnvironment(),
      capabilities: {
        terminal: { status: "available", value: {} as never },
        jobs: { status: "available", value: {} as never },
      },
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    });

    expect(runtime.toolRegistry.has("Shell")).toBe(true);
    expect(runtime.toolRegistry.has("Read")).toBe(true);
    expect(runtime.toolRegistry.has("Write")).toBe(true);
    expect(runtime.toolRegistry.has("TerminalOpen")).toBe(true);
    await runtime.close();
  });

  it("hides undeclared local-only tools from WSL agents", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      executionEnvironment: wslEnvironment(),
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        tools: [testTool("PluginTool")],
      },
    });

    expect(runtime.toolRegistry.has("PluginTool")).toBe(false);
    await runtime.close();
  });

  it("hides brokered web tools when WSL networking is disabled", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      executionEnvironment: wslEnvironment("none"),
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    });

    expect(runtime.toolRegistry.has("WebFetch")).toBe(false);
    expect(runtime.toolRegistry.has("WebSearch")).toBe(false);
    await runtime.close();
  });

  it("registers agent tools before applying visibility filters", async () => {
    const custom = testTool("BusinessSearch");
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        tools: [custom],
        hostToolCeiling: ["BusinessSearch"],
      },
    });

    try {
      expect(runtime.toolRegistry.get("BusinessSearch")).toBe(custom);
      expect(runtime.toolRegistry.inspect("BusinessSearch")).toEqual({
        name: "BusinessSearch",
        source: { kind: "agent" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not trust a caller tool that borrows a disabled builtin name", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        tools: [testTool("JobList")],
        autoApproveReadOnly: true,
      },
      capabilities: {
        jobs: { status: "disabled" },
        terminal: { status: "disabled" },
        backgroundShell: { status: "disabled" },
        memory: { status: "disabled" },
        childEnvironment: { status: "disabled" },
        workflowRepository: { status: "disabled" },
        schedules: { status: "disabled" },
      },
    });

    try {
      await expect(runtime.permissionChecker.checkTool("JobList", {}))
        .resolves.toMatchObject({ action: "ask" });
    } finally {
      await runtime.close();
    }
  });

  it("replaces a built-in only through toolOverrides and records provenance", async () => {
    const replacement = testTool("Read");
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        toolOverrides: [replacement],
      },
    });

    try {
      expect(runtime.toolRegistry.get("Read")).toBe(replacement);
      expect(runtime.toolRegistry.inspect("Read")).toEqual({
        name: "Read",
        source: { kind: "agent" },
        overrides: { kind: "builtin" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects trusted names that are not configured tool overrides", async () => {
    const client = {
      async *streamMessage() {
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };

    await expect(createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client,
        trustedToolOverrides: ["Read"],
      },
    })).rejects.toThrow(/trustedToolOverrides.*Read.*toolOverrides/i);

    await expect(createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client,
        toolOverrides: [testTool("Read")],
        trustedToolOverrides: ["Raed"],
      },
    })).rejects.toThrow(/trustedToolOverrides.*Raed.*toolOverrides/i);
  });

  it("only preserves builtin read trust for an explicitly trusted override", async () => {
    const client = {
      async *streamMessage() {
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };
    const cwd = resolve(tmpdir(), "vk-trust-test-repo");
    const outsidePath = resolve(tmpdir(), "secret.txt");
    const readOverride = testTool("Read");
    const untrusted = await createVykorRuntime({
      settings: BASE_SETTINGS,
      cwd,
      configuration: { client, toolOverrides: [readOverride] },
    });
    const trusted = await createVykorRuntime({
      settings: BASE_SETTINGS,
      cwd,
      configuration: {
        client,
        toolOverrides: [readOverride],
        trustedToolOverrides: ["Read"],
      },
    });

    try {
      await expect(untrusted.permissionChecker.checkTool("Read", {
        file_path: resolve(cwd, "notes.txt"),
      })).resolves.toMatchObject({ action: "ask" });
      await expect(trusted.permissionChecker.checkTool("Read", {
        file_path: resolve(cwd, "notes.txt"),
      })).resolves.toMatchObject({ action: "allow" });
      await expect(trusted.permissionChecker.checkTool("Read", {
        file_path: outsidePath,
      })).resolves.toMatchObject({ action: "ask" });
      await expect(trusted.permissionChecker.checkTool("Read", {
        file_path: "attachment://att-1/notes.txt",
      })).resolves.toMatchObject({ action: "allow" });
    } finally {
      await untrusted.close();
      await trusted.close();
    }
  });

  it("rejects ambiguous additions and invalid overrides before startup", async () => {
    const client = {
      async *streamMessage() {
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };

    await expect(createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: { client, tools: [testTool("Read")] },
    })).rejects.toThrow(/already registered/i);
    await expect(createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: { client, toolOverrides: [testTool("Raed")] },
    })).rejects.toThrow(/override target.*not registered/i);
    await expect(createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client,
        tools: [testTool("BusinessSearch")],
        toolOverrides: [testTool("BusinessSearch")],
      },
    })).rejects.toThrow(/both tools and toolOverrides/i);
  });

  it("rejects removed lifecycle names with the Jobs replacement", async () => {
    await expect(createVykorRuntime({
      settings: {
        ...BASE_SETTINGS,
        permission: { mode: "default", deniedTools: ["task_wait"] },
      },
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    })).rejects.toThrow(
      'settings.permission.deniedTools contains removed lifecycle tool names: "task_wait" -> "JobWait"',
    );
  });

  it("applies allowedTools and deniedTools to tools registered after runtime creation", async () => {
    const runtime = await createVykorRuntime({
      settings: {
        ...BASE_SETTINGS,
        permission: { mode: "default", allowedTools: ["Shell"] },
      },
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["ToolSearch", "DynamicAllowed"],
        disallowedTools: ["DynamicDenied"],
      },
    });

    runtime.toolRegistry.register({
      name: "DynamicAllowed",
      description: "Allowed dynamic tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });
    runtime.toolRegistry.register({
      name: "DynamicDenied",
      description: "Denied dynamic tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["ToolSearch", "DynamicAllowed"]);
      expect(runtime.toolRegistry.get("DynamicAllowed")).toBeDefined();
      expect(runtime.toolRegistry.get("DynamicDenied")).toBeUndefined();
      expect(runtime.toolRegistry.get("ToolSearch")).toBeDefined();
      expect(runtime.toolRegistry.get("Shell")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("keeps roleAllowedTools under the host tool ceiling", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Read", "Agent"],
        roleAllowedTools: ["*"],
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["Read", "Agent"]);
      expect(runtime.toolRegistry.get("Shell")).toBeUndefined();
      expect(runtime.toolRegistry.get("Edit")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("exposes zero tools when the host ceiling and role tools do not overlap", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Read"],
        roleAllowedTools: ["Shell"],
      },
    });

    try {
      expect(runtime.toolRegistry.getAll()).toEqual([]);
      expect(runtime.toolRegistry.get("Read")).toBeUndefined();
      expect(runtime.toolRegistry.get("Shell")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("treats '*' as all tools while deniedTools still wins", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["*"],
        disallowedTools: ["Write"],
      },
    });

    runtime.toolRegistry.register({
      name: "DynamicMcpTool",
      description: "Dynamic MCP tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toContain("Shell");
      expect(names).toContain("Read");
      expect(names).toContain("DynamicMcpTool");
      expect(names).not.toContain("Write");
      expect(runtime.toolRegistry.get("Write")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("uses the current exact tool names when filtering", async () => {
    const runtime = await createVykorRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Shell", "Edit", "ToolSearch"],
        disallowedTools: ["ToolSearch"],
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["Shell", "Edit"]);
      expect(runtime.toolRegistry.get("Shell")).toBeDefined();
      expect(runtime.toolRegistry.get("Edit")).toBeDefined();
      expect(runtime.toolRegistry.get("ToolSearch")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
