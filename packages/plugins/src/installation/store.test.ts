import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverInstalledNativePlugins, readInstalledPluginStore, updateInstalledPluginStore } from "./store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vk-plugin-store-")); file = join(dir, "installed.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("installed plugin store", () => {
  it("starts empty and atomically increments revision", async () => {
    expect(await readInstalledPluginStore(file)).toEqual({ schemaVersion: 1, revision: 0, plugins: {} });
    await updateInstalledPluginStore(file, (store) => {
      store.plugins["user:dev.example.plugin"] = {
        id: "dev.example.plugin", scope: "user", enabled: true, currentVersion: "1",
        cachePath: "cache", origin: "native", requestedPermissions: [], approvedPermissions: [],
        installedAt: "now", updatedAt: "now",
      };
    });
    expect((await readInstalledPluginStore(file)).revision).toBe(1);
    expect(JSON.parse(await readFile(file, "utf8")).revision).toBe(1);
  });

  it("rejects unsupported store versions", async () => {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, JSON.stringify({ schemaVersion: 2 })));
    await expect(readInstalledPluginStore(file)).rejects.toThrow("Unsupported installed plugin store");
  });

  it.each(["project", "local"])("rejects a persisted %s installation scope", async (scope) => {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      plugins: {
        legacy: {
          id: "dev.example.legacy", scope, enabled: true, currentVersion: "1", cachePath: "cache",
          origin: "native", requestedPermissions: [], approvedPermissions: [], installedAt: "now", updatedAt: "now",
        },
      },
    })));

    await expect(readInstalledPluginStore(file)).rejects.toThrow("Invalid installed plugin store");
  });

  it("discovers enabled user and managed installations", async () => {
    await updateInstalledPluginStore(file, (store) => {
      const common = {
        enabled: true, currentVersion: "1", cachePath: "cache", origin: "native" as const,
        requestedPermissions: [], approvedPermissions: [], installedAt: "now", updatedAt: "now",
      };
      store.plugins["user::dev.example.user"] = { id: "dev.example.user", scope: "user", ...common };
      store.plugins["managed::dev.example.managed"] = { id: "dev.example.managed", scope: "managed", ...common };
    });

    const records = await discoverInstalledNativePlugins({ cwd: "C:/workspace", storePath: file });
    expect(records.map((record) => record.scope).sort()).toEqual(["managed", "user"]);
  });
});
