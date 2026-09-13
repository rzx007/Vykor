import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildController,
  AgentExecutionContext,
  Settings,
} from "@openharness/core";
import { computePluginBehaviorDigest, installLocalNativePlugin } from "@openharness/plugins";
import { ToolRegistry } from "@openharness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenHarnessRuntime } from "./default-runtime.js";
import {
  configureDiscoveredExtensions,
  createExtensionToolRegistry,
  discoverOpenHarnessExtensions,
} from "./extensions.js";
import { getNativeToolRuntimeSnapshot } from "./native-tools/status.js";

const BASE_SETTINGS: Settings = {
  model: "host-model",
  apiFormat: "anthropic",
  maxTurns: 8,
  permission: { mode: "default" },
};

let tempRoot: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ohs-runtime-extensions-"));
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  process.env.OPENHARNESS_CONFIG_DIR = join(tempRoot, "config");
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OPENHARNESS_CONFIG_DIR;
  } else {
    process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeProjectAgentPlugin(cwd: string, suffix: string, model: string): void {
  const pluginDir = join(tempRoot, "cache", suffix);
  const agentsDir = join(pluginDir, "agents");
  mkdirSync(join(pluginDir, ".openharness-plugin"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, ".openharness-plugin", "plugin.json"),
    JSON.stringify({ schemaVersion: 1, id: `dev.openharness.${suffix}`, name: suffix, version: "1.0.0", components: { agents: ["./agents"] } }),
  );
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    `---\nmodel: ${model}\n---\nReview only this workspace.\n`,
  );
  const storePath = join(tempRoot, "config", "plugins", "installed.json");
  mkdirSync(join(storePath, ".."), { recursive: true });
  let store: { schemaVersion: 1; revision: number; plugins: Record<string, unknown> } = { schemaVersion: 1, revision: 0, plugins: {} };
  try { store = JSON.parse(readFileSync(storePath, "utf8")); } catch {}
  store.plugins[`project:${cwd}:dev.openharness.${suffix}`] = {
    id: `dev.openharness.${suffix}`, scope: "user", enabled: true,
    currentVersion: "1.0.0", cachePath: pluginDir, origin: "native", requestedPermissions: [],
    approvedPermissions: [], linkedSourcePath: pluginDir, installedAt: "now", updatedAt: "now",
  };
  writeFileSync(storePath, JSON.stringify(store));
}

function writeProjectToolPlugin(cwd: string): void {
  const pluginDir = join(tempRoot, "cache", "runtime-tool");
  mkdirSync(join(pluginDir, ".openharness-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "tools"), { recursive: true });
  writeFileSync(join(pluginDir, ".openharness-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.openharness.runtime-tool",
    name: "runtime-tool",
    version: "1.0.0",
    components: { tools: ["./tools/index.mjs"] },
  }));
  writeFileSync(join(pluginDir, "tools", "index.mjs"), `
    export async function registerTools() {
      return [{
        name: "InstalledPluginEcho", description: "installed plugin echo", inputSchema: {},
        async invoke(input) { return { content: [{ type: "text", text: String(input.value) }] }; }
      }];
    }
  `);
  const storePath = join(tempRoot, "config", "plugins", "installed.json");
  mkdirSync(join(storePath, ".."), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    plugins: {
      "user::dev.openharness.runtime-tool": {
        id: "dev.openharness.runtime-tool",
        scope: "user",
        enabled: true,
        currentVersion: "1.0.0",
        cachePath: pluginDir,
        origin: "native",
        requestedPermissions: [],
        approvedPermissions: [],
        linkedSourcePath: pluginDir,
        installedAt: "now",
        updatedAt: "now",
      },
    },
  }));
}

function writeProjectMcpPlugin(cwd: string): void {
  const pluginDir = join(tempRoot, "cache", "runtime-mcp");
  mkdirSync(join(pluginDir, ".openharness-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "mcp"), { recursive: true });
  writeFileSync(join(pluginDir, ".openharness-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.openharness.runtime-mcp",
    name: "runtime-mcp",
    version: "1.0.0",
    components: { mcpServers: ["./mcp/servers.json"] },
  }));
  writeFileSync(join(pluginDir, "mcp", "servers.json"), JSON.stringify({
    servers: { github: { type: "http", url: "https://mcp.example.test" } },
  }));
  const storePath = join(tempRoot, "config", "plugins", "installed.json");
  mkdirSync(join(storePath, ".."), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    plugins: {
      "user::dev.openharness.runtime-mcp": {
        id: "dev.openharness.runtime-mcp",
        scope: "user",
        enabled: true,
        currentVersion: "1.0.0",
        cachePath: pluginDir,
        origin: "native",
        requestedPermissions: [],
        approvedPermissions: [],
        linkedSourcePath: pluginDir,
        installedAt: "now",
        updatedAt: "now",
      },
    },
  }));
}

function createExecutionContext(
  cwd: string,
  calls: Parameters<AgentChildController["spawnChildAgent"]>[0][],
): AgentExecutionContext {
  const children: AgentChildController = {
    hasChildAgent: vi.fn(() => false),
    spawnChildAgent: vi.fn(async (input) => {
      calls.push(input);
      return {
        id: `child-${calls.length}`,
        sessionId: `child-session-${calls.length}`,
        result: Promise.resolve({
          status: "completed" as const,
          output: "done",
        }),
      };
    }),
    sendChildInput: vi.fn(async () => {}),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => ({
      status: "completed" as const,
      output: "done",
    })),
  };
  return {
    scope: {
      agentId: "leader",
      sessionId: "leader-session",
      inputId: "input-1",
      runId: "run-1",
      traceId: "trace-1",
      cwd,
      signal: new AbortController().signal,
    },
    effects: {
      requestPermission: vi.fn(async () => ({ status: "approved" as const })),
    },
    children,
    emit: vi.fn(async () => {}),
    takeSteeredInputs: vi.fn(async () => []),
    closeSteering: vi.fn(),
  };
}

async function spawnReviewer(
  runtime: Awaited<ReturnType<typeof createOpenHarnessRuntime>>,
  cwd: string,
) {
  const calls: Parameters<AgentChildController["spawnChildAgent"]>[0][] = [];
  const tool = runtime.toolRegistry.get("Agent");
  expect(tool).toBeDefined();

  await tool!.execute(
    {
      description: "review",
      prompt: "review this workspace",
      subagentType: cwd.endsWith("workspace-a")
        ? "dev.openharness.plugin-a:reviewer"
        : "dev.openharness.plugin-b:reviewer",
    },
    { cwd, agent: createExecutionContext(cwd, calls) },
  );

  return calls[0];
}

describe("extension agent definition scoping", () => {
  it("gives programmatic extensions an add-only registry with extension provenance", () => {
    const registry = new ToolRegistry();
    const builtin = {
      name: "Read",
      description: "builtin read",
      inputSchema: {},
      async execute() { return { content: [] }; },
    };
    registry.register(builtin, { kind: "builtin" });
    const extensionRegistry = createExtensionToolRegistry(registry);

    expect((extensionRegistry as unknown as { override?: unknown }).override).toBeUndefined();
    expect(() => extensionRegistry.register({ ...builtin, description: "shadow" }))
      .toThrow(/already registered/i);
    expect(registry.get("Read")).toBe(builtin);

    extensionRegistry.register({ ...builtin, name: "ExtensionEcho" });
    expect(registry.inspect("ExtensionEcho")).toEqual({
      name: "ExtensionEcho",
      source: { kind: "extension" },
    });
  });

  it("keeps two live runtimes bound to the plugin agents discovered for their own cwd", async () => {
    const cwdA = join(tempRoot, "workspace-a");
    const cwdB = join(tempRoot, "workspace-b");
    writeProjectAgentPlugin(cwdA, "plugin-a", "model-a");
    writeProjectAgentPlugin(cwdB, "plugin-b", "model-b");

    const discoveryA = await discoverOpenHarnessExtensions(cwdA, BASE_SETTINGS);
    expect(discoveryA.pluginCapabilityInventory.agents.get("dev.openharness.plugin-a:reviewer"))
      .toEqual({ pluginId: "dev.openharness.plugin-a" });
    const runtimeA = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd: cwdA,
      configuration: {
        client: {
          async *streamMessage() {
            yield {
              type: "complete" as const,
              stopReason: "end_turn" as const,
            };
          },
        },
      },
      agentDefinitions: discoveryA.agentDefinitions,
    });

    const discoveryB = await discoverOpenHarnessExtensions(cwdB, BASE_SETTINGS);
    const runtimeB = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd: cwdB,
      configuration: {
        client: {
          async *streamMessage() {
            yield {
              type: "complete" as const,
              stopReason: "end_turn" as const,
            };
          },
        },
      },
      agentDefinitions: discoveryB.agentDefinitions,
    });

    try {
      const [spawnedByA, spawnedByB] = await Promise.all([
        spawnReviewer(runtimeA, cwdA),
        spawnReviewer(runtimeB, cwdB),
      ]);
      expect(spawnedByA?.model).toBe("model-a");
      expect(spawnedByB?.model).toBe("model-b");
    } finally {
      await Promise.all([runtimeA.close(), runtimeB.close()]);
    }
  });
});

describe("installed Native Tool activation", () => {
  it("keeps compound MCP ownership identity out of the Runtime server key", async () => {
    const cwd = join(tempRoot, "mcp-identity-workspace");
    writeProjectMcpPlugin(cwd);

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.pluginCapabilityInventory.mcpServers.get(
      "plugin:dev.openharness.runtime-mcp:mcp:github",
    )).toEqual({ pluginId: "dev.openharness.runtime-mcp", serverName: "github" });
    expect(discovery.mcpServers).toEqual({
      github: { type: "http", url: "https://mcp.example.test" },
    });
    expect(discovery.warnings).toEqual([]);
  });

  it("rejects an injected host MCP config that reuses an installed plugin server name", async () => {
    const cwd = join(tempRoot, "mcp-host-collision");
    mkdirSync(cwd, { recursive: true });
    writeProjectMcpPlugin(cwd);
    const { createDefaultNodeAgent } = await import("./default-agent.js");
    await expect(createDefaultNodeAgent({
      cwd, settings: BASE_SETTINGS, systemPrompt: "test",
      client: { streamMessage: async function* () { yield { type: "complete" as const, stopReason: "end_turn" }; } },
      capabilityOverrides: { terminal: false, memory: false },
      mcpServers: { github: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] } },
    }).then((agent) => agent.close())).rejects.toThrow(/MCP server name.*github.*conflict/i);
  });

  it("keeps an ambiguous installation out of the discovery inventory with a diagnostic", async () => {
    const cwd = join(tempRoot, "ambiguous-installation-workspace");
    const storePath = join(tempRoot, "config", "plugins", "installed.json");
    mkdirSync(join(storePath, ".."), { recursive: true });
    const common = {
      id: "dev.openharness.ambiguous",
      scope: "user",
      enabled: true,
      currentVersion: "1.0.0",
      origin: "native",
      requestedPermissions: [],
      approvedPermissions: [],
      installedAt: "now",
      updatedAt: "now",
    };
    writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      plugins: {
        "user:first:dev.openharness.ambiguous": { ...common, cachePath: join(tempRoot, "first") },
        "user:second:dev.openharness.ambiguous": { ...common, cachePath: join(tempRoot, "second") },
      },
    }));

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect([...discovery.pluginCapabilityInventory.plugins.keys()]).toEqual([]);
    expect(discovery.pluginCapabilityInventory.diagnostics).toEqual([{
      severity: "error",
      phase: "discover",
      code: "plugin_installation_ambiguous",
      message: "Cannot choose one user installation for plugin dev.openharness.ambiguous",
      pluginId: "dev.openharness.ambiguous",
      details: { scope: "user", count: 2 },
    }]);
  });

  it("skips installed plugins when the master switch is disabled", async () => {
    const cwd = join(tempRoot, "disabled-tool-workspace");
    writeProjectToolPlugin(cwd);
    const disabled = await discoverOpenHarnessExtensions(cwd, {
      ...BASE_SETTINGS,
      plugins: { enabled: false },
      mcpServers: { direct: { type: "http", url: "https://mcp.example.test" } },
    });
    expect(disabled.plugins).toEqual([]);
    expect(disabled.mcpServers).toEqual({
      direct: { type: "http", url: "https://mcp.example.test" },
    });
    const cannotBypassMaster = await discoverOpenHarnessExtensions(
      cwd,
      { ...BASE_SETTINGS, plugins: { enabled: false } },
      { pluginsEnabled: true },
    );
    expect(cannotBypassMaster.plugins).toEqual([]);

    const overridden = await discoverOpenHarnessExtensions(
      cwd,
      { ...BASE_SETTINGS, plugins: { enabled: true } },
      { pluginsEnabled: false },
    );
    expect(overridden.plugins).toEqual([]);
  });

  it("does not discover plugins with unapproved permissions", async () => {
    const cwd = join(tempRoot, "missing-permission-workspace");
    writeProjectToolPlugin(cwd);
    const storePath = join(tempRoot, "config", "plugins", "installed.json");
    const store = JSON.parse(readFileSync(storePath, "utf8")) as {
      plugins: Record<string, { requestedPermissions: string[]; approvedPermissions: string[] }>;
    };
    const record = Object.values(store.plugins)[0]!;
    record.requestedPermissions = ["filesystem:write"];
    record.approvedPermissions = [];
    writeFileSync(storePath, JSON.stringify(store));
    const manifestPath = join(tempRoot, "cache", "runtime-tool", ".openharness-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.permissions = { filesystem: ["write"] };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      "dev.openharness.runtime-tool: missing approved plugin permissions [filesystem:write]; approve the permissions or reinstall the plugin before it can run",
    ]);
  });

  it("rejects a linked plugin whose actual manifest requests different permissions", async () => {
    const cwd = join(tempRoot, "permission-drift-workspace");
    writeProjectToolPlugin(cwd);
    const manifestPath = join(tempRoot, "cache", "runtime-tool", ".openharness-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.permissions = { filesystem: ["write"] };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      "dev.openharness.runtime-tool: actual plugin permissions [filesystem:write] differ from the installed permission request []; reinstall the plugin",
    ]);
  });

  it("rejects a copied plugin when its cached content no longer matches the installed digest", async () => {
    const cwd = join(tempRoot, "digest-drift-workspace");
    const source = join(tempRoot, "digest-source");
    mkdirSync(join(source, ".openharness-plugin"), { recursive: true });
    mkdirSync(join(source, "skills", "digest-skill"), { recursive: true });
    writeFileSync(join(source, ".openharness-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "dev.openharness.digest-check",
      name: "digest-check",
      version: "1.0.0",
      components: { skills: ["./skills"] },
    }));
    writeFileSync(join(source, "skills", "digest-skill", "SKILL.md"), "---\nname: digest-skill\ndescription: digest fixture\n---\nOriginal.\n");
    const installed = await installLocalNativePlugin({
      sourcePath: source,
      scope: "user",
      cwd,
      approvedPermissions: [],
      cacheDir: join(tempRoot, "config", "plugins", "cache"),
      storePath: join(tempRoot, "config", "plugins", "installed.json"),
    });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") return;
    expect(installed.record.behaviorDigest).toBe(await computePluginBehaviorDigest(installed.record.cachePath));
    const trustedDiscovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    expect(trustedDiscovery.plugins.map((plugin) => plugin.manifest.id)).toEqual(["dev.openharness.digest-check"]);
    expect(trustedDiscovery.warnings).toEqual([]);
    writeFileSync(join(installed.record.cachePath, "unexpected.txt"), "changed after installation");

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      "dev.openharness.digest-check: cached plugin content does not match the installed digest; reinstall the plugin",
    ]);

    const reinstalled = await installLocalNativePlugin({
      sourcePath: source,
      scope: "user",
      cwd,
      approvedPermissions: [],
      cacheDir: join(tempRoot, "config", "plugins", "cache"),
      storePath: join(tempRoot, "config", "plugins", "installed.json"),
    });
    expect(reinstalled.status).toBe("installed");

    const recoveredDiscovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    expect(recoveredDiscovery.plugins.map((plugin) => plugin.manifest.id)).toEqual(["dev.openharness.digest-check"]);
    expect(recoveredDiscovery.warnings).toEqual([]);
  });

  it("rejects a legacy copied user installation that has no trusted digest", async () => {
    const cwd = join(tempRoot, "legacy-user-workspace");
    writeProjectToolPlugin(cwd);
    const storePath = join(tempRoot, "config", "plugins", "installed.json");
    const store = JSON.parse(readFileSync(storePath, "utf8")) as {
      plugins: Record<string, { linkedSourcePath?: string }>;
    };
    delete Object.values(store.plugins)[0]!.linkedSourcePath;
    writeFileSync(storePath, JSON.stringify(store));

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      "dev.openharness.runtime-tool: copied plugin installation has no trusted content digest; reinstall the plugin",
    ]);
  });

  it("rejects a copied plugin whose installed snapshot root was replaced by a directory link", async () => {
    const cwd = join(tempRoot, "linked-snapshot-workspace");
    const source = join(tempRoot, "linked-snapshot-source");
    mkdirSync(join(source, ".openharness-plugin"), { recursive: true });
    mkdirSync(join(source, "skills", "linked-snapshot-skill"), { recursive: true });
    writeFileSync(join(source, ".openharness-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "dev.openharness.linked-snapshot",
      name: "linked-snapshot",
      version: "1.0.0",
      components: { skills: ["./skills"] },
    }));
    writeFileSync(join(source, "skills", "linked-snapshot-skill", "SKILL.md"), "---\nname: linked-snapshot-skill\ndescription: fixture\n---\nOriginal.\n");
    const installed = await installLocalNativePlugin({
      sourcePath: source,
      scope: "user",
      cwd,
      approvedPermissions: [],
      cacheDir: join(tempRoot, "config", "plugins", "cache"),
      storePath: join(tempRoot, "config", "plugins", "installed.json"),
    });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") return;
    const external = join(tempRoot, "mutable-external-snapshot");
    cpSync(installed.record.cachePath, external, { recursive: true });
    rmSync(installed.record.cachePath, { recursive: true, force: true });
    symlinkSync(external, installed.record.cachePath, process.platform === "win32" ? "junction" : "dir");

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      "dev.openharness.linked-snapshot: copied plugin cache snapshot is not a regular directory; reinstall the plugin",
    ]);
  });

  it.each([
    ["id", "dev.openharness.replaced", "1.0.0"],
    ["version", "dev.openharness.runtime-tool", "2.0.0"],
  ] as const)("rejects a linked plugin whose manifest %s differs from its installation record", async (_field, id, version) => {
    const cwd = join(tempRoot, `identity-drift-${_field}`);
    writeProjectToolPlugin(cwd);
    const manifestPath = join(tempRoot, "cache", "runtime-tool", ".openharness-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.id = id;
    manifest.version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins).toEqual([]);
    expect(discovery.warnings).toEqual([
      `dev.openharness.runtime-tool: actual plugin identity ${id}@${version} differs from installed identity dev.openharness.runtime-tool@1.0.0; reinstall the plugin`,
    ]);
  });

  it("allows linked plugin code to change when its manifest identity and permissions stay unchanged", async () => {
    const cwd = join(tempRoot, "linked-code-workspace");
    writeProjectToolPlugin(cwd);
    writeFileSync(join(tempRoot, "cache", "runtime-tool", "tools", "extra.txt"), "development change");

    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);

    expect(discovery.plugins.map((plugin) => plugin.manifest.id)).toEqual(["dev.openharness.runtime-tool"]);
    expect(discovery.warnings).toEqual([]);
  });

  it("discovers, invokes, and removes a Tool with its owning runtime", async () => {
    const cwd = join(tempRoot, "tool-workspace");
    writeProjectToolPlugin(cwd);
    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    expect(discovery.pluginCapabilityInventory.plugins.get("dev.openharness.runtime-tool"))
      .toMatchObject({
        pluginId: "dev.openharness.runtime-tool",
        version: "1.0.0",
        scope: "user",
        origin: "native",
        nativeToolEntries: ["plugin:dev.openharness.runtime-tool:tool:./tools/index.mjs"],
      });
    expect(discovery.pluginCapabilityInventory.nativeToolEntries.get(
      "plugin:dev.openharness.runtime-tool:tool:./tools/index.mjs",
    ))
      .toEqual({ pluginId: "dev.openharness.runtime-tool" });
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    });
    const activations = await configureDiscoveredExtensions(discovery, {
      cwd,
      toolRegistry: runtime.toolRegistry,
      hookExecutor: runtime.hookExecutor,
      addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
    });
    expect(activations[0]).toMatchObject({ state: "active", toolNames: ["InstalledPluginEcho"] });
    expect(runtime.toolRegistry.inspect("InstalledPluginEcho")).toEqual({
      name: "InstalledPluginEcho",
      source: { kind: "plugin", id: "dev.openharness.runtime-tool" },
    });
    expect(getNativeToolRuntimeSnapshot(discovery.plugins[0]!.root)).toMatchObject({
      state: "active",
      hostCount: 1,
      registeredToolCount: 1,
      toolNames: ["InstalledPluginEcho"],
    });
    await expect(runtime.toolRegistry.get("InstalledPluginEcho")!.execute({ value: "hello" }, { cwd })).resolves.toEqual({
      content: [{ type: "text", text: "hello" }],
    });
    await runtime.close();
    expect(runtime.toolRegistry.has("InstalledPluginEcho")).toBe(false);
    expect(getNativeToolRuntimeSnapshot(discovery.plugins[0]!.root)).toMatchObject({ state: "inactive", hostCount: 0 });
  });

  it("does not start a native Tool host for WSL execution", async () => {
    const cwd = join(tempRoot, "wsl-tool-workspace");
    writeProjectToolPlugin(cwd);
    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    const registry = new ToolRegistry();

    const activations = await configureDiscoveredExtensions(discovery, {
      cwd,
      environmentKind: "wsl",
      toolRegistry: registry,
      hookExecutor: { register: vi.fn() } as any,
      addCleanup: vi.fn(),
    });

    expect(activations).toEqual([expect.objectContaining({
      state: "inactive",
      toolNames: [],
      diagnostics: [expect.objectContaining({ code: "native_tools_unavailable_in_environment" })],
    })]);
    expect(registry.has("InstalledPluginEcho")).toBe(false);
    expect(getNativeToolRuntimeSnapshot(discovery.plugins[0]!.root)).toMatchObject({
      state: "inactive",
      hostCount: 0,
    });
  });
});
