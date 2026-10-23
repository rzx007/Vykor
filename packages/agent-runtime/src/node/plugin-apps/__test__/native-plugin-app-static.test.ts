import { type NodeRuntimeResources as RuntimeBundle } from "../../runtime/node-runtime-resources.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstalledPluginStorePath } from "@vykor/host-config";
import { ToolRegistry } from "@vykor/core";
import { McpClientManager } from "@vykor/mcp";
import { installLocalNativePlugin, installedPluginKey, loadNativePlugin, updateInstalledPluginStore, validateNativePlugin } from "@vykor/plugins";
import { SkillRegistry } from "@vykor/skills";
import { nativeAppDefinition, writeNativeAppFixture } from "../../../../../plugins/src/test-helpers/native-app.js";
import { createVykorRuntime } from "../../runtime/default-runtime.js";
import { NativeToolHost } from "../../plugins/native-tools/tool-host.js";
import { captureNativePluginAppBackend, createNativePluginAppResourceSnapshot } from "../native-plugin-app-backend.js";
import { createPluginCapabilityInventory } from "../../plugins/plugin-capability-inventory.js";
import { installRuntimeIntegrations } from "../../runtime/runtime-integrations.js";

let root: string | undefined;
let runtime: RuntimeBundle | undefined;
afterEach(async () => {
  await runtime?.close(); runtime = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true }); root = undefined;
});

describe("Native static apps without a Tool Host", () => {
  it("installs, loads and captures apps-only resources without processes, revoking old generations on failed validation and runtime close", async () => {
    root = await mkdtemp(join(tmpdir(), "vykor-static-app-"));
    vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
    const definition = nativeAppDefinition();
    const backend = definition.backends[0]!;
    if (backend.kind !== "native-tools") throw new Error("fixture");
    backend.tools = [];
    const fixture = await writeNativeAppFixture(join(root, "source"), definition);
    fixture.manifest.components = { apps: ["./ui/apps.json"] };
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));

    const startHost = vi.spyOn(NativeToolHost.prototype, "start");
    const startMcp = vi.spyOn(McpClientManager.prototype, "prepareConnection");
    const installed = await installLocalNativePlugin({ sourcePath: fixture.root, scope: "user", cwd: root,
      cacheDir: join(root, "cache"), approvedPermissions: ["ui:invoke-own-tools", "ui:render"] });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") throw new Error("installation failed");
    const validated = await validateNativePlugin(installed.record.cachePath);
    expect(validated.status).toBe("valid");
    const plugin = await loadNativePlugin(validated.plugin!);
    expect(plugin.components.apps?.status).toBe("loaded");
    expect(plugin.components.tools).toBeUndefined();

    const skillRegistry = new SkillRegistry();
    runtime = await createVykorRuntime({ cwd: root, skillRegistry,
      settings: { model: "test", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" }, sandbox: { enabled: false } },
      configuration: { client: { async *streamMessage() { throw new Error("static app must not request a model"); } } },
    });
    const { pluginApps } = await installRuntimeIntegrations({ cwd: root, sessionId: "static-app-session", runtime, settings: runtime.settings,
      discovery: { skillRegistry, plugins: [plugin], agentDefinitions: [], warnings: [], mcpServers: {},
        pluginCapabilityInventory: createPluginCapabilityInventory([{ plugin, record: installed.record, behaviorDigest: installed.record.behaviorDigest }]),
      },
    });
    expect(pluginApps.list()).toHaveLength(1);
    const captured = await pluginApps.capture(plugin.manifest.id, "editor");
    expect(captured).toBeDefined();
    expect(captured!.tools.size).toBe(0);
    expect(captured!.isCurrentTool("SaveDocument")).toBe(false);
    expect(captured!.port.supportsSubscriptions).toBe(false);
    expect(captured!.port.isCurrent()).toBe(true);
    expect((await captured!.port.listResources()).resources).toEqual([
      expect.objectContaining({ uri: "ui://fixture/panel.html" }),
    ]);
    expect((await captured!.port.readResource("ui://fixture/panel.html")).contents).toEqual([
      expect.objectContaining({ uri: "ui://fixture/panel.html", text: "<!doctype html><p>App</p>" }),
    ]);
    expect(await captured!.port.listResourceTemplates()).toEqual({ resourceTemplates: [] });
    await expect(captured!.port.readResource("ui://fixture/undeclared.html")).rejects.toThrow("not_declared");
    expect((await pluginApps.capture(plugin.manifest.id, "editor"))!.port.generation).toBe(captured!.port.generation);

    await updateInstalledPluginStore(getInstalledPluginStorePath(), store => {
      store.plugins[installedPluginKey(installed.record)]!.enabled = false;
    });
    await expect(pluginApps.capture(plugin.manifest.id, "editor")).rejects.toThrow();
    expect(captured!.port.isCurrent()).toBe(false);
    await expect(captured!.port.readResource("ui://fixture/panel.html")).rejects.toThrow("backend_changed");
    await expect(captured!.port.listResources()).rejects.toThrow("backend_changed");

    await updateInstalledPluginStore(getInstalledPluginStorePath(), store => {
      store.plugins[installedPluginKey(installed.record)]!.enabled = true;
    });
    const reopened = await pluginApps.capture(plugin.manifest.id, "editor");
    expect(reopened!.port.generation).not.toBe(captured!.port.generation);
    expect(captured!.port.isCurrent()).toBe(false);
    await runtime.close(); runtime = undefined;
    expect(reopened!.port.isCurrent()).toBe(false);
    await expect(reopened!.port.listResources()).rejects.toThrow("backend_changed");
    expect(await pluginApps.capture(plugin.manifest.id, "editor")).toBeUndefined();
    expect(startHost).not.toHaveBeenCalled();
    expect(startMcp).not.toHaveBeenCalled();
  });

  it("does not let a resource snapshot replace the original Host required by mapped tools", async () => {
    root = await mkdtemp(join(tmpdir(), "vykor-static-app-mapping-"));
    const fixture = await writeNativeAppFixture(root);
    const plugin = await loadNativePlugin(fixture);
    const metadata = plugin.components.apps!.value![0]!;
    const snapshot = createNativePluginAppResourceSnapshot();
    expect(() => captureNativePluginAppBackend({ pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version,
      pluginDigest: "digest", metadata, definition: metadata.definition.backends[0]!, root: fixture.root,
      toolRegistry: new ToolRegistry(), resourceSnapshot: snapshot })).toThrow("backend_unavailable");
    snapshot.revoke();
    expect(snapshot.isCurrent()).toBe(false);
  });
});
