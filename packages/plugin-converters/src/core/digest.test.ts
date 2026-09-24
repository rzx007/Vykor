import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { digestSource } from "./digest.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("distinguishes binary content from file boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-source-digest-")); cleanup.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets/a"), "x\0assets/b\0y");
  const before = await digestSource(root);
  await writeFile(join(root, "assets/a"), "x");
  await writeFile(join(root, "assets/b"), "y");
  expect(await digestSource(root)).not.toBe(before);
});

it("refuses a linked source root before hashing its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-source-link-")); cleanup.push(root);
  await mkdir(join(root, "source")); await writeFile(join(root, "source/file"), "content");
  await symlink(join(root, "source"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await expect(digestSource(join(root, "link"))).rejects.toThrow(/link/i);
});
