import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeNativeAppFixture } from "../../__test__/helpers/native-app.js";
import { installLocalNativePlugin } from "../installer.js";
import { readInstalledPluginStore, updateInstalledPluginStore } from "../store.js";
import * as api from "../../index.js";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "plugin-relocation-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const source = join(root, "source"), stage = join(root, "stage"), final = join(root, "final"), external = join(root, "linked");
  await writeNativeAppFixture(external);
  const store = join(source, "installed.json");
  const installed = await installLocalNativePlugin({ sourcePath: external, scope: "user", cwd: root, storePath: store, cacheDir: join(source, "cache"), approvedPermissions: ["ui:invoke-own-tools", "ui:render"] });
  if (installed.status !== "installed") throw new Error("Fixture installation failed");
  await cp(source, stage, { recursive: true });
  return { source, stage, final, store, installed, moves: [{ kind: "user-root", from: source, to: final }] };
}
it("validates staged physical plugin bytes while storing final paths and preserving authorization", async () => {
  const f = await fixture(); const before = await readFile(f.store, "utf8");
  const linked = { ...f.installed.record, cachePath: join(root, "linked"), linkedSourcePath: join(root, "linked") };
  await updateInstalledPluginStore(join(f.stage, "installed.json"), store => { store.plugins["linked"] = linked; });
  expect(api).toHaveProperty("relocateInstalledPluginStore");
  const report = await (api as any).relocateInstalledPluginStore(join(f.stage, "installed.json"), f.moves, { stagedRoot: f.stage, targetRoot: f.final });
  expect(report.unsupported).toEqual([]);
  const next = await readInstalledPluginStore(join(f.stage, "installed.json"));
  const record = Object.values(next.plugins)[0]!;
  expect(record).toEqual({ ...f.installed.record, cachePath: f.installed.record.cachePath.replace(f.source, f.final) });
  expect(next.plugins.linked).toEqual(linked);
  expect(await readFile(f.store, "utf8")).toBe(before);
});
it("rejects changed staged plugin bytes without changing the copied store", async () => {
  const f = await fixture(), path = join(f.stage, "installed.json"), before = await readFile(path, "utf8");
  await writeFile(join(f.installed.record.cachePath.replace(f.source, f.stage), "ui", "panel.html"), "changed");
  expect(api).toHaveProperty("relocateInstalledPluginStore");
  await expect((api as any).relocateInstalledPluginStore(path, f.moves, { stagedRoot: f.stage, targetRoot: f.final })).rejects.toThrow("plugin_content_digest_mismatch");
  expect(await readFile(path, "utf8")).toBe(before);
});
