import type { LoadedNativePlugin, InstalledPluginRecord } from "@openharness/plugins";
import { describe, expect, it } from "vitest";

import {
  createPluginCapabilityInventory,
  selectPluginInstallationWinners,
} from "./plugin-capability-inventory.js";

function record(
  id: string,
  scope: "user" | "managed" = "user",
  overrides: Partial<InstalledPluginRecord> = {},
): InstalledPluginRecord {
  return {
    id,
    scope,
    enabled: true,
    currentVersion: "1.2.3",
    cachePath: `/plugins/${scope}/${id}`,
    origin: "converted",
    requestedPermissions: [],
    approvedPermissions: [],
    installedAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function loaded(
  installation: InstalledPluginRecord,
  components: LoadedNativePlugin["components"],
  overrides: Partial<LoadedNativePlugin["manifest"]> = {},
): { record: InstalledPluginRecord; plugin: LoadedNativePlugin } {
  const name = installation.id.split(".").at(-1)!;
  return {
    record: installation,
    plugin: {
      manifest: {
        schemaVersion: 1,
        id: installation.id,
        name,
        displayName: "Quality Suite",
        description: "Checks a workspace",
        version: installation.currentVersion,
        components: { skills: ["./skills"] },
        ...overrides,
      },
      root: installation.cachePath,
      status: "loaded",
      components,
      diagnostics: [],
    },
  };
}

describe("plugin capability inventory", () => {
  it("rejects every plugin sharing a bare MCP server name instead of choosing a last writer", () => {
    const component = { status: "loaded" as const, diagnostics: [], value: { shared: { type: "stdio" as const, command: "node" } } };
    const inventory = createPluginCapabilityInventory([
      loaded(record("dev.first"), { mcpServers: component }),
      loaded(record("dev.second"), { mcpServers: component }),
      loaded(record("dev.unrelated"), {}),
    ]);
    expect([...inventory.plugins.keys()]).toEqual(["dev.unrelated"]);
    expect(inventory.mcpServers.size).toBe(0);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({
      component: "mcpServers", code: "plugin_component_name_conflict",
      details: { name: "shared", pluginIds: ["dev.first", "dev.second"] },
    })]);
  });

  it("rejects plugin MCP names already reserved by host settings", () => {
    const inventory = createPluginCapabilityInventory([
      loaded(record("dev.first"), { mcpServers: { status: "loaded", diagnostics: [], value: {
        shared: { type: "stdio", command: "node" },
      } } }),
    ], { reservedMcpServerNames: ["shared"] });
    expect(inventory.plugins.size).toBe(0);
    expect(inventory.mcpServers.size).toBe(0);
    expect(inventory.diagnostics).toEqual([expect.objectContaining({
      pluginId: "dev.first", component: "mcpServers", code: "plugin_mcp_server_name_conflict",
    })]);
  });

  it("records current installation metadata and static component ownership", () => {
    const installation = record("dev.openharness.quality");
    const inventory = createPluginCapabilityInventory([
      loaded(installation, {
        skills: {
          status: "loaded",
          value: [{
            name: "workspace-review",
            commandName: "quality:workspace-review",
            description: "Review a workspace",
            content: "Review.",
            path: "/plugins/user/dev.openharness.quality/skills/review/SKILL.md",
            source: "plugin",
            metadata: { pluginId: "dev.openharness.quality" },
            userInvocable: true,
            disableModelInvocation: false,
          }],
          diagnostics: [],
        },
        mcpServers: {
          status: "loaded",
          value: { github: { type: "http", url: "https://mcp.example.test" } },
          diagnostics: [],
        },
        tools: {
          status: "loaded",
          value: [{
            declaredEntry: "./tools/index.mjs",
            entryPath: "/plugins/user/dev.openharness.quality/tools/index.mjs",
            runtime: "node",
            requestedPermissions: [],
            effectivePermissions: {},
          }],
          diagnostics: [],
        },
        agents: {
          status: "loaded",
          value: [{
            name: "dev.openharness.quality:reviewer",
            description: "Review changes",
            source: "plugin",
          }],
          diagnostics: [],
        },
      }),
    ]);

    expect(inventory.plugins.get("dev.openharness.quality")).toEqual({
      pluginId: "dev.openharness.quality",
      displayName: "Quality Suite",
      description: "Checks a workspace",
      version: "1.2.3",
      scope: "user",
      origin: "converted",
      skillNames: ["workspace-review"],
      mcpServerIds: ["plugin:dev.openharness.quality:mcp:github"],
      nativeToolEntries: ["plugin:dev.openharness.quality:tool:./tools/index.mjs"],
      agentNames: ["dev.openharness.quality:reviewer"],
    });
    expect(inventory.skills.get("workspace-review")).toEqual({
      pluginId: "dev.openharness.quality",
      path: "/plugins/user/dev.openharness.quality/skills/review/SKILL.md",
    });
    expect(inventory.mcpServers.get("plugin:dev.openharness.quality:mcp:github")).toEqual({
      pluginId: "dev.openharness.quality",
      serverName: "github",
    });
    expect(inventory.nativeToolEntries.get("plugin:dev.openharness.quality:tool:./tools/index.mjs")).toEqual({
      pluginId: "dev.openharness.quality",
    });
    expect(inventory.agents.get("dev.openharness.quality:reviewer")).toEqual({
      pluginId: "dev.openharness.quality",
    });
    expect(inventory.diagnostics).toEqual([]);
  });

  it("prefers managed over user and rejects an ambiguous highest-priority installation", () => {
    const user = record("dev.openharness.quality", "user");
    const managed = record("dev.openharness.quality", "managed");
    const resolved = selectPluginInstallationWinners([user, managed]);

    expect(resolved.winners).toEqual([managed]);
    expect(resolved.diagnostics).toEqual([]);

    const ambiguous = selectPluginInstallationWinners([
      managed,
      { ...managed, cachePath: "/plugins/managed-copy/dev.openharness.quality" },
    ]);
    expect(ambiguous.winners).toEqual([]);
    expect(ambiguous.diagnostics).toEqual([{
      severity: "error",
      phase: "discover",
      code: "plugin_installation_ambiguous",
      message: "Cannot choose one managed installation for plugin dev.openharness.quality",
      pluginId: "dev.openharness.quality",
      details: { scope: "managed", count: 2 },
    }]);
  });

  it("excludes every plugin involved in a bare component name collision", () => {
    const firstRecord = record("dev.openharness.first", "user", { origin: "native" });
    const secondRecord = record("dev.openharness.second", "user", { origin: "native" });
    const skill = (pluginId: string, path: string) => ({
      status: "loaded" as const,
      value: [{
        name: "review",
        commandName: `${pluginId}:review`,
        description: "Review",
        content: "Review.",
        path,
        source: "plugin" as const,
        metadata: { pluginId },
        userInvocable: true,
        disableModelInvocation: false,
      }],
      diagnostics: [],
    });

    const inventory = createPluginCapabilityInventory([
      loaded(firstRecord, { skills: skill(firstRecord.id, "/first/review/SKILL.md") }),
      loaded(secondRecord, { skills: skill(secondRecord.id, "/second/review/SKILL.md") }),
    ]);

    expect([...inventory.plugins.keys()]).toEqual([]);
    expect([...inventory.skills.keys()]).toEqual([]);
    expect(inventory.diagnostics).toEqual([{
      severity: "error",
      phase: "discover",
      code: "plugin_component_name_conflict",
      message: "Plugin component name 'review' is owned by multiple plugins: dev.openharness.first, dev.openharness.second",
      component: "skills",
      details: {
        name: "review",
        pluginIds: ["dev.openharness.first", "dev.openharness.second"],
      },
    }]);
  });

  it("keeps identical plugin-relative Native Tool entries under distinct owner identities", () => {
    const firstRecord = record("dev.openharness.first", "user", { origin: "native" });
    const secondRecord = record("dev.openharness.second", "user", { origin: "native" });
    const tools = {
      status: "loaded" as const,
      value: [{
        declaredEntry: "./tools/index.mjs",
        entryPath: "/plugin/tools/index.mjs",
        runtime: "node" as const,
        requestedPermissions: [],
        effectivePermissions: {},
      }],
      diagnostics: [],
    };

    const inventory = createPluginCapabilityInventory([
      loaded(firstRecord, { tools }),
      loaded(secondRecord, { tools }),
    ]);

    expect([...inventory.plugins.keys()]).toEqual([
      "dev.openharness.first",
      "dev.openharness.second",
    ]);
    expect([...inventory.nativeToolEntries.entries()]).toEqual([
      ["plugin:dev.openharness.first:tool:./tools/index.mjs", { pluginId: firstRecord.id }],
      ["plugin:dev.openharness.second:tool:./tools/index.mjs", { pluginId: secondRecord.id }],
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });
});
