import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeNativeUiFixture } from "../test-helpers/native-ui.js";
import { computePluginBehaviorDigest } from "./cache.js";
import { verifyInstalledNativePlugin } from "./verify.js";
import { installLocalNativePlugin, requestedPluginPermissions } from "./installer.js";
import { loadNativePlugin } from "../load-native-plugin.js";
import type { InstalledPluginRecord } from "./store.js";

it("keeps verified installed tools/skills, never parses retired HTML, and rejects new import", async () => {
  const root = await mkdtemp(join(tmpdir(), "retired-plugin-"));
  try {
    const plugin = await writeNativeUiFixture(root);
    await writeFile(join(root, "ui/manifest.json"), "not JSON: must not be parsed");
    const requested = requestedPluginPermissions(plugin.manifest);
    const record: InstalledPluginRecord = { id: plugin.manifest.id, currentVersion: plugin.manifest.version, scope: "user", enabled: true,
      cachePath: root, behaviorDigest: await computePluginBehaviorDigest(root), origin: "native", requestedPermissions: requested,
      approvedPermissions: requested, installedAt: "original", updatedAt: "original" };
    const checked = await verifyInstalledNativePlugin(record);
    expect(checked.status).toBe("valid");
    if (checked.status !== "valid") throw new Error("fixture verification failed");
    expect(checked.diagnostics[0]?.code).toBe("plugin_ui_retired");
    const loaded = await loadNativePlugin(checked.plugin);
    expect(loaded.components.skills?.value).toHaveLength(1);
    expect(loaded.components.tools?.value).toHaveLength(1);
    expect(loaded.components).not.toHaveProperty("ui");
    expect(loaded.components.apps).toBeUndefined();
    const imported = await installLocalNativePlugin({ sourcePath: root, cwd: root, scope: "user", approvedPermissions: requested, storePath: join(root, "installed.json") });
    expect(imported.status).toBe("invalid");
    expect(imported.diagnostics[0]?.code).toBe("plugin_ui_retired");
    for (const patch of [{ id: "wrong.identity" }, { currentVersion: "9" }, { requestedPermissions: [] }, { approvedPermissions: [] }, { behaviorDigest: "0".repeat(64) }]) {
      expect((await verifyInstalledNativePlugin({ ...record, ...patch })).status).toBe("invalid");
    }
    await writeFile(join(root, "ui/findings.html"), "changed retired HTML still changes original digest");
    expect((await verifyInstalledNativePlugin(record)).status).toBe("invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});
