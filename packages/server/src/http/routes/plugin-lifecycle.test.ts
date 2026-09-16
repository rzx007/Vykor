import { readFile, writeFile } from "node:fs/promises";
import { getInstalledPluginStorePath } from "@openharness/core";
import { getNativeToolRuntimeSnapshot } from "@openharness/agent-runtime";
import {
  discoverInstalledNativePlugins, readInstalledPluginStore, verifyInstalledNativePlugin,
} from "@openharness/plugins";
import { describe, expect, it } from "vitest";
import { OpenHarnessClient } from "../../../../client/src/transport/http-client.js";
import { dispatchSessionCommand } from "../../../../client/src/commands/session-commands.js";
import { createInitialClientState } from "../../../../client/src/state/reducer.js";
import type { ReloadPluginsResponse } from "../../../../client/src/types/index.js";
import {
  callInspector, expectRuntimeStopped, pluginId, settings, toolName, withNativePluginFixture,
  type NativePluginFixture,
} from "../../../../agent-runtime/test-helpers/native-plugin-authoring.js";
import { createDefaultPluginService } from "../../application/default-services/plugin-service.js";
import { DaemonOperationGate } from "../../application/control/daemon-operation-gate.js";
import { createServiceRoutes, type ServiceRoutesContext } from "./service.js";

function lifecycleRoutes(fixture: NativePluginFixture) {
  const gate = new DaemonOperationGate();
  const closedCwds: string[] = [];
  let globalCloseCount = 0;
  // This adapter holds the real activation cleanup callbacks. Model runs/AgentPool are out of scope.
  const control: ServiceRoutesContext["control"] = {
    acquireCwdMutation: cwd => gate.tryEnterBarrier({ kind: "cwd", cwd }, () => true),
    acquireGlobalMutation: () => gate.tryEnterBarrier({ kind: "global" }, () => true),
    async closeRuntimesForCwd(cwd) {
      closedCwds.push(cwd);
      await Promise.all(fixture.runtimes.filter(runtime => runtime.cwd === cwd).map(runtime => runtime.close()));
    },
    async closeAllRuntimes() {
      globalCloseCount += 1;
      await fixture.closeAll();
    },
    runtimeInspectionAvailable: false,
    sessionExists: () => false,
    async inspectRuntimeHooks() { throw new Error("Hook inspection is outside this lifecycle test"); },
  };
  const app = createServiceRoutes({ pluginService: createDefaultPluginService({ current: settings }), control });
  const requests: Array<{ path: string; method: string }> = [];
  const reloadResponses: ReloadPluginsResponse[] = [];
  const client = new OpenHarnessClient({
    baseUrl: "http://plugin-lifecycle.test",
    async fetch(input, init) {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({ path, method: request.method });
      const response = await app.request(request);
      if (path === "/plugins/reload") reloadResponses.push(await response.clone().json() as ReloadPluginsResponse);
      return response;
    },
  });
  return {
    client, requests, reloadResponses, closedCwds,
    get globalCloseCount() { return globalCloseCount; },
    async install(link: boolean) {
      await client.plugins.installLocal({
        cwd: fixture.cwds[0], sourcePath: fixture.source, scope: "user", approvedPermissions: [], link,
      });
      expect(requests.at(-1)).toEqual({ path: link ? "/plugins/link-local" : "/plugins/install-local", method: "POST" });
      const records = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: pluginId, origin: "native", scope: "user", enabled: true });
      if (link) expect(records[0]!.linkedSourcePath).toBe(fixture.source);
      return records[0]!;
    },
    async reloadViaSlash(cwd = fixture.cwds[0]) {
      const emitted: string[] = [];
      const outcome = await dispatchSessionCommand({ name: "/reload-plugins", args: "" }, {
        client, cwd, commandCatalog: [], clientState: createInitialClientState(), busy: false,
        emit: text => emitted.push(text),
      });
      expect(outcome).toBe("handled");
      expect(requests.at(-1)).toEqual({ path: "/plugins/reload", method: "POST" });
      expect(emitted).toHaveLength(1);
      return emitted[0]!;
    },
  };
}

describe("plugin lifecycle routes with real installation, discovery, registry and child processes", () => {
  it("reloads linked implementation changes through the actual slash/HTTP route before reactivation", async () => {
    await withNativePluginFixture(async fixture => {
      const routes = lifecycleRoutes(fixture);
      const installed = await routes.install(true);
      const oldRuntime = await fixture.activate();
      const oldTool = oldRuntime.registry.get(toolName)!;
      await expect(callInspector(oldRuntime)).resolves.toEqual({ content: [{
        type: "text", text: JSON.stringify({ findings: [{ line: 1, code: "trailing-whitespace" }], truncated: false }),
      }] });
      const manifestBefore = await readFile(fixture.manifest, "utf8");
      const source = await readFile(fixture.entry, "utf8");
      expect(source).toContain('"trailing-whitespace"');
      await writeFile(fixture.entry, source.replaceAll('"trailing-whitespace"', '"trailing-whitespace-v2"'));

      const output = await routes.reloadViaSlash();
      expect(routes.closedCwds).toEqual([fixture.cwds[0]]);
      await expectRuntimeStopped(oldRuntime);
      await expect(oldTool.execute({ text: "ok  \n" }, { cwd: oldRuntime.cwd }))
        .rejects.toMatchObject({ code: "tool_host_unavailable" });
      expect(output).toContain("reload on next use");
      expect(output).toContain("[enabled/installed/reload-required]");
      expect(output).not.toMatch(/successfully (?:activated|reloaded)|\[enabled\/installed\/active\]/i);
      expect(routes.reloadResponses[0]!.plugins[0]!.toolRuntime).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
      expect(await fixture.executions()).toHaveLength(1);
      expect(await readFile(fixture.manifest, "utf8")).toBe(manifestBefore);
      expect(Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)).toEqual([installed]);
      expect((await verifyInstalledNativePlugin(installed)).status).toBe("valid");

      const newRuntime = await fixture.activate();
      expect(newRuntime.activation!.host).not.toBe(oldRuntime.activation!.host);
      expect(newRuntime.pid).not.toBe(oldRuntime.pid);
      await expect(callInspector(newRuntime)).resolves.toEqual({ content: [{
        type: "text", text: JSON.stringify({ findings: [{ line: 1, code: "trailing-whitespace-v2" }], truncated: false }),
      }] });
      expect(oldRuntime.registry.has(toolName)).toBe(false);
    });
  });

  it("shows permission drift as invalid with link/approve guidance through the actual slash callback, then skips discovery", async () => {
    await withNativePluginFixture(async fixture => {
      const routes = lifecycleRoutes(fixture);
      const installed = await routes.install(true);
      const runtime = await fixture.activate();
      await callInspector(runtime);
      const manifest = JSON.parse(await readFile(fixture.manifest, "utf8"));
      manifest.permissions = { network: ["example.test"] };
      await writeFile(fixture.manifest, JSON.stringify(manifest));

      const output = await routes.reloadViaSlash();
      await expectRuntimeStopped(runtime);
      expect(routes.closedCwds).toEqual([fixture.cwds[0]]);
      expect(routes.reloadResponses[0]!.plugins[0]).toMatchObject({
        installation: "invalid", activation: "reload-required",
        diagnostics: [expect.objectContaining({ code: "plugin_installation_permissions_mismatch" })],
      });
      expect(output).toContain("[enabled/invalid/reload-required]");
      expect(output).toContain("plugin_installation_permissions_mismatch");
      expect(output).toContain("network:example.test");
      expect(output).toContain("ohs plugin link <source>");
      expect(output).toContain("--approve <permission>");
      expect(output).toContain("reload on next use");
      expect(output).not.toMatch(/successfully (?:activated|reloaded)|\[enabled\/installed\/active\]/i);
      expect((await verifyInstalledNativePlugin(installed)).status).toBe("invalid");
      // Enabled records remain installed; the full runtime discovery must perform verification and skip them.
      expect(await discoverInstalledNativePlugins({ cwd: fixture.cwds[0] })).toEqual([installed]);
      for (const cwd of fixture.cwds) {
        const discovery = await fixture.discover(cwd);
        expect(discovery.plugins).toEqual([]);
        expect(discovery.warnings.join("\n")).toContain("actual plugin permissions [network:example.test]");
      }
      expect(await fixture.executions()).toHaveLength(1);
      expect(Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)).toEqual([installed]);
    });
  });

  it.each([
    { operation: "disable", link: false }, { operation: "disable", link: true },
    { operation: "uninstall", link: false }, { operation: "uninstall", link: true },
  ] as const)("$operation stops both cwd hosts and persists removal from discovery (link=$link)", async ({ operation, link }) => {
    await withNativePluginFixture(async fixture => {
      const routes = lifecycleRoutes(fixture);
      const installed = await routes.install(link);
      const first = await fixture.activate(fixture.cwds[0]);
      const second = await fixture.activate(fixture.cwds[1]);
      expect(first.pid).not.toBe(second.pid);
      const firstResult = await callInspector(first);
      expect(firstResult.isError).not.toBe(true);
      await expect(callInspector(second)).resolves.toEqual(firstResult);
      // Status reports unique tool names; each cwd still owns its own registry and Host.
      expect(first.registry.getAll()).toHaveLength(1);
      expect(second.registry.getAll()).toHaveLength(1);
      expect(getNativeToolRuntimeSnapshot(installed.cachePath)).toMatchObject({ hostCount: 2, registeredToolCount: 1 });
      const before = await readInstalledPluginStore(getInstalledPluginStorePath());
      const previousCloses = routes.globalCloseCount;

      if (operation === "disable") await routes.client.plugins.disable(pluginId, { cwd: fixture.cwds[0] });
      else await routes.client.plugins.uninstall(pluginId, { cwd: fixture.cwds[0] });
      expect(routes.requests.at(-1)).toEqual({
        path: `/plugins/${pluginId}${operation === "disable" ? "/disable" : ""}`,
        method: operation === "disable" ? "POST" : "DELETE",
      });
      expect(routes.globalCloseCount).toBe(previousCloses + 1);
      expect(routes.closedCwds).toEqual([]);
      await expectRuntimeStopped(first);
      await expectRuntimeStopped(second);
      expect(getNativeToolRuntimeSnapshot(installed.cachePath)).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
      const after = await readInstalledPluginStore(getInstalledPluginStorePath());
      expect(after.revision).toBe(before.revision + 1);
      if (operation === "disable") {
        expect(Object.values(after.plugins)).toEqual([{ ...installed, enabled: false, updatedAt: expect.any(String) }]);
        expect((await routes.client.plugins.list({ cwd: fixture.cwds[1] })).plugins[0]).toMatchObject({
          enabled: false, activation: "inactive", toolRuntime: { hostCount: 0, registeredToolCount: 0 },
        });
      } else {
        expect(after.plugins).toEqual({});
        expect((await routes.client.plugins.list({ cwd: fixture.cwds[1] })).plugins).toEqual([]);
      }
      for (const cwd of fixture.cwds) {
        expect(await discoverInstalledNativePlugins({ cwd })).toEqual([]);
        expect((await fixture.discover(cwd)).plugins).toEqual([]);
      }
      expect(await fixture.executions()).toHaveLength(2);
    });
  });
});
