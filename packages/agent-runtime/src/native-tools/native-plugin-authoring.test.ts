import { access, rm } from "node:fs/promises";
import { getInstalledPluginStorePath } from "@openharness/core";
import {
  discoverInstalledNativePlugins, installLocalNativePlugin, loadNativePlugin,
  readInstalledPluginStore, validateNativePlugin, verifyInstalledNativePlugin,
} from "@openharness/plugins";
import { describe, expect, it } from "vitest";
import {
  callInspector, expectRuntimeStopped, pluginId, withNativePluginFixture,
} from "../../test-helpers/native-plugin-authoring.js";

describe("native plugin authoring installation (real Tool Host)", () => {
  it("keeps a verified user snapshot callable after its source is deleted", async () => {
    await withNativePluginFixture(async fixture => {
      const installed = await installLocalNativePlugin({
        sourcePath: fixture.source, cwd: fixture.cwds[0], scope: "user", approvedPermissions: [],
      });
      expect(installed.status, JSON.stringify(installed.diagnostics)).toBe("installed");
      if (installed.status !== "installed") throw new Error("Expected installation");
      expect(installed.record).toMatchObject({
        id: pluginId, origin: "native", scope: "user", enabled: true,
        requestedPermissions: [], approvedPermissions: [], behaviorDigest: expect.any(String),
      });
      expect(installed.record.behaviorDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(installed.record.linkedSourcePath).toBeUndefined();
      expect(installed.record.cachePath).not.toBe(fixture.source);
      const stored = Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins);
      expect(stored).toEqual([installed.record]);
      expect(await fixture.executions()).toEqual([]);

      await rm(fixture.source, { recursive: true, force: true });
      await expect(access(fixture.source)).rejects.toMatchObject({ code: "ENOENT" });
      const records = await discoverInstalledNativePlugins({ cwd: fixture.cwds[1] });
      expect(records).toEqual(stored);
      const verified = await verifyInstalledNativePlugin(records[0]!);
      expect(verified.status).toBe("valid");
      if (verified.status !== "valid") throw new Error("Expected verified snapshot");
      expect((await loadNativePlugin(verified.plugin)).root).toBe(installed.record.cachePath);
      const runtime = await fixture.activate(fixture.cwds[1]);
      await expect(callInspector(runtime)).resolves.toEqual({ content: [{
        type: "text", text: JSON.stringify({ findings: [{ line: 1, code: "trailing-whitespace" }], truncated: false }),
      }] });
      await runtime.close();
      await expectRuntimeStopped(runtime);
    });
  });

  it("does not execute the entry during static validation/load/discovery; activation executes in a child", async () => {
    await withNativePluginFixture(async fixture => {
      // Inspect the manifest and contributions without importing the executable entry.
      const inspected = await validateNativePlugin(fixture.source);
      expect(inspected.status).toBe("valid");
      expect((await loadNativePlugin(inspected.plugin!)).components.tools?.value).toHaveLength(1);
      expect(await fixture.executions()).toEqual([]);
      const installed = await installLocalNativePlugin({
        sourcePath: fixture.source, cwd: fixture.cwds[0], scope: "user", approvedPermissions: [], link: true,
      });
      expect(installed.status).toBe("installed");
      const discovery = await fixture.discover();
      expect(discovery.plugins.map(plugin => plugin.manifest.id)).toEqual([pluginId]);
      expect(discovery.agentDefinitions.map(agent => agent.name)).toContain(`${pluginId}:reviewer`);
      expect(discovery.pluginCapabilityInventory.agents.get(`${pluginId}:reviewer`)).toEqual({ pluginId });
      expect(await fixture.executions()).toEqual([]);

      const runtime = await fixture.activate();
      await callInspector(runtime);
      expect(await fixture.executions()).toEqual([{ pid: runtime.pid, host: "1" }]);
      await runtime.close();
      await expectRuntimeStopped(runtime);
    });
  });
});
