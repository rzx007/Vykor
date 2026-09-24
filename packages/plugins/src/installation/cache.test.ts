import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePluginBehaviorDigest, materializePluginCache } from "./cache.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vk-plugin-cache-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("plugin cache", () => {
  it("computes a stable content digest and materializes an immutable versioned directory", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    const digest = await computePluginBehaviorDigest(source);
    expect(await computePluginBehaviorDigest(source)).toBe(digest);
    const target = await materializePluginCache(source, join(root, "cache"), "dev.example.plugin", "1.0.0", digest);
    expect(target).toBe(join(root, "cache", "dev.example.plugin", `1.0.0-${digest}`));
    expect(await readdir(join(root, "cache", "dev.example.plugin"))).toEqual([`1.0.0-${digest}`]);
  });

  it("keeps the previously installed snapshot intact when the same plugin ID is reinstalled", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "first");

    const cacheRoot = join(root, "cache");
    const pluginCacheRoot = join(cacheRoot, "dev.example.plugin");
    const firstDigest = await computePluginBehaviorDigest(source);
    const firstTarget = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", firstDigest);
    expect(await readFile(join(firstTarget, "payload.txt"), "utf8")).toBe("first");
    expect(await readdir(pluginCacheRoot)).toEqual([`1.0.0-${firstDigest}`]);

    await writeFile(join(source, "payload.txt"), "second");
    const secondDigest = await computePluginBehaviorDigest(source);
    const secondTarget = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "2.0.0", secondDigest);

    expect(secondTarget).not.toBe(firstTarget);
    expect(await readFile(join(firstTarget, "payload.txt"), "utf8")).toBe("first");
    expect(await readFile(join(secondTarget, "payload.txt"), "utf8")).toBe("second");
    expect(await readdir(pluginCacheRoot)).toEqual([
      `1.0.0-${firstDigest}`,
      `2.0.0-${secondDigest}`,
    ]);
  });

  it("keeps the previous immutable cache when candidate validation fails", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "known-good");

    const cacheRoot = join(root, "cache");
    const firstDigest = await computePluginBehaviorDigest(source);
    const current = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", firstDigest);

    await writeFile(join(source, "payload.txt"), "invalid-candidate");
    const secondDigest = await computePluginBehaviorDigest(source);
    await expect(materializePluginCache(
      source,
      cacheRoot,
      "dev.example.plugin",
      "2.0.0",
      secondDigest,
      async () => { throw new Error("candidate validation failed"); },
    )).rejects.toThrow("candidate validation failed");

    expect(await readFile(join(current, "payload.txt"), "utf8")).toBe("known-good");
    expect(await readdir(join(cacheRoot, "dev.example.plugin"))).toEqual([`1.0.0-${firstDigest}`]);
  });

  it("rejects a copied snapshot when the source changed after its digest was computed", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "approved content");
    const digest = await computePluginBehaviorDigest(source);
    await writeFile(join(source, "payload.txt"), "changed content");

    await expect(materializePluginCache(
      source,
      join(root, "cache"),
      "dev.example.plugin",
      "1.0.0",
      digest,
    )).rejects.toThrow("Plugin source changed while it was being cached");
    expect(await readdir(join(root, "cache", "dev.example.plugin"))).toEqual([]);
  });

  it("rejects a pre-created snapshot root symlink or junction", async () => {
    const source = join(root, "source");
    const external = join(root, "external");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    const digest = await computePluginBehaviorDigest(source);
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "payload.txt"), "external mutable content");
    const parent = join(root, "cache", "dev.example.plugin");
    const target = join(parent, `1.0.0-${digest}`);
    await mkdir(parent, { recursive: true });
    await symlink(external, target, process.platform === "win32" ? "junction" : "dir");

    await expect(materializePluginCache(
      source,
      join(root, "cache"),
      "dev.example.plugin",
      "1.0.0",
      digest,
    )).rejects.toThrow("Plugin cache snapshot is not a regular directory");
  });

  it("repairs a corrupted snapshot when reinstalling the original content", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "known-good");
    const digest = await computePluginBehaviorDigest(source);
    const cacheRoot = join(root, "cache");
    const target = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", digest);
    await writeFile(join(target, "payload.txt"), "corrupted");

    const repaired = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", digest);

    expect(repaired).toBe(target);
    expect(await readFile(join(repaired, "payload.txt"), "utf8")).toBe("known-good");
    expect(await readdir(join(cacheRoot, "dev.example.plugin"))).toEqual([`1.0.0-${digest}`]);
  });

  it("repairs a snapshot whose contents prevent digest calculation without deleting the link target", async () => {
    const source = join(root, "source");
    const external = join(root, "external");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "known-good");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), "must survive cache repair");
    const digest = await computePluginBehaviorDigest(source);
    const cacheRoot = join(root, "cache");
    const target = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", digest);
    await symlink(external, join(target, "redirected"), process.platform === "win32" ? "junction" : "dir");

    const repaired = await materializePluginCache(source, cacheRoot, "dev.example.plugin", "1.0.0", digest);

    expect(repaired).toBe(target);
    expect(await readdir(repaired)).toEqual([".vykor-plugin", "payload.txt"]);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe("must survive cache repair");
    expect(await readdir(join(cacheRoot, "dev.example.plugin"))).toEqual([`1.0.0-${digest}`]);
  });
});
