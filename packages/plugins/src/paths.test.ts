import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativePluginPathError, resolveNativePluginPath } from "./paths.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "vk-native-paths-"));
  root = join(base, "plugin");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("resolveNativePluginPath", () => {
  it.each(["../outside", "./../outside", "C:/Windows/System32", "D:/other", "//server/share/file"])(
    "rejects an escaping or absolute declaration: %s",
    async (declaredPath) => {
      await expect(resolveNativePluginPath(root, declaredPath)).rejects.toBeInstanceOf(
        NativePluginPathError,
      );
    },
  );

  it("resolves an existing path inside the plugin", async () => {
    await mkdir(join(root, "skills"));
    expect(await resolveNativePluginPath(root, "./skills")).toBe(await realpath(join(root, "skills")));
  });

  it("resolves a not-yet-created target through its nearest existing parent", async () => {
    const resolved = await resolveNativePluginPath(root, "./generated/nested/file.json");
    expect(resolved).toBe(join(await realpath(root), "generated", "nested", "file.json"));
  });

  it("rejects a symlink that escapes the plugin and accepts an internal symlink when supported", async (context) => {
    await mkdir(join(root, "inside"));
    try {
      await symlink(outside, join(root, "outside-link"), "junction");
      await symlink(join(root, "inside"), join(root, "inside-link"), "junction");
    } catch (error) {
      context.skip(`当前环境不能创建 symlink/junction: ${String(error)}`);
      return;
    }

    await expect(resolveNativePluginPath(root, "./outside-link/secret.txt")).rejects.toBeInstanceOf(
      NativePluginPathError,
    );
    expect(await resolveNativePluginPath(root, "./inside-link")).toBe(await realpath(join(root, "inside")));
  });

  it("treats Windows path casing as the same root", async () => {
    if (process.platform !== "win32") return;
    await mkdir(join(root, "Skills"));
    const differentlyCasedRoot = root.toUpperCase();
    expect(await resolveNativePluginPath(differentlyCasedRoot, "./Skills")).toBe(
      await realpath(join(root, "Skills")),
    );
  });
});
