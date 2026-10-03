import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNativeUiFixture } from "../test-helpers/native-ui.js";
import { installLocalNativePlugin } from "./installer.js";
import { readInstalledPluginStore, updateInstalledPluginStore } from "./store.js";
import { verifyInstalledNativePlugin } from "./verify.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vk-ui-verify-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function install() {
  const sourcePath = join(root, "source");
  await writeNativeUiFixture(sourcePath);
  const storePath = join(root, "installed.json");
  const installed = await installLocalNativePlugin({ sourcePath, scope: "user", cwd: root, storePath,
    cacheDir: join(root, "cache"), approvedPermissions: ["ui:invoke-own-tools", "ui:render"] });
  if (installed.status !== "installed") throw new Error("expected installed UI fixture");
  return { record: installed.record, storePath };
}

describe("verifyInstalledNativePlugin UI", () => {
  it("verifies an approved UI snapshot even after its source is removed", async () => {
    const { record } = await install();
    await rm(join(root, "source"), { recursive: true });
    expect((await verifyInstalledNativePlugin(record)).status).toBe("valid");
  });

  it("refuses obsolete authorization requests without silently granting UI capabilities", async () => {
    const { record, storePath } = await install();
    await updateInstalledPluginStore(storePath, store => {
      store.plugins[`user::${record.id}`]!.requestedPermissions = [];
      store.plugins[`user::${record.id}`]!.approvedPermissions = [];
    });
    const old = (await readInstalledPluginStore(storePath)).plugins[`user::${record.id}`]!;
    const result = await verifyInstalledNativePlugin(old);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics[0]?.code).toBe("plugin_installation_permissions_mismatch");
    expect((await readInstalledPluginStore(storePath)).plugins[`user::${record.id}`]!.approvedPermissions).toEqual([]);
  });

  it("refuses a missing UI approval and modified HTML bytes", async () => {
    const { record } = await install();
    const missing = await verifyInstalledNativePlugin({ ...record, approvedPermissions: ["ui:render"] });
    expect(missing.status).toBe("invalid");
    expect(missing.diagnostics[0]?.code).toBe("plugin_permissions_not_approved");
    await writeFile(join(record.cachePath, "ui", "findings.html"), "<!doctype html><p>Changed</p>");
    const changed = await verifyInstalledNativePlugin(record);
    expect(changed.status).toBe("invalid");
    expect(changed.diagnostics[0]?.code).toBe("plugin_content_digest_mismatch");
  });
});
