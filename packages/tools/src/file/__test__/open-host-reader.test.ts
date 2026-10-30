import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHostFileReader } from "../open-host-reader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("held host file reader", () => {
  it("rejects another read after the reader has been consumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-once-")); roots.push(root);
    const file = join(root, "value.txt"); await writeFile(file, "hello");
    const reader = await openHostFileReader(file);
    try {
      expect(Buffer.from(await reader.readBytes({ maxBytes: 2 })).toString("utf8")).toBe("he");
      await expect(reader.readBytes({ maxBytes: 5 })).rejects.toMatchObject({ code: "EALREADY" });
    } finally { await reader.close(); }
  });

  it("does not read a replacement outside directory through an authorized parent path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-")); roots.push(root);
    const inside = join(root, "inside");
    const outside = join(root, "outside");
    await mkdir(inside); await mkdir(outside);
    await writeFile(join(inside, "value.txt"), "INSIDE");
    await writeFile(join(outside, "value.txt"), "OUTSIDE");
    const reader = await openHostFileReader(join(inside, "value.txt"));
    try {
      try {
        await rename(inside, join(root, "original"));
        await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        // Windows can also prevent renaming a directory with an open child.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      expect(Buffer.from(await reader.readBytes({ maxBytes: 20 })).toString("utf8")).toBe("INSIDE");
    } finally { await reader.close(); }
  });

  it.each([
    { maxBytes: 0, expected: Buffer.alloc(0) },
    { maxBytes: 4, expected: Buffer.from([0xe4, 0xbd, 0xa0, 0xe5]) },
    { maxBytes: 100, expected: Buffer.from("你好!") },
  ])("preserves Unicode paths and returns at most $maxBytes bytes", async ({ maxBytes, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-unicode-")); roots.push(root);
    const file = join(root, "中文-é-🙂.txt");
    await writeFile(file, "你好!");
    const reader = await openHostFileReader(file);
    try {
      expect(reader.canonicalPath).toBe(await realpath(file));
      expect(reader.stat).toMatchObject({ isFile: true, isDirectory: false, sizeBytes: 7 });
      expect(Buffer.from(await reader.readBytes({ maxBytes }))).toEqual(expected);
    } finally { await reader.close(); }
  });

  it("does not consume the reader for invalid limits or a pre-cancelled read", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-retry-")); roots.push(root);
    const file = join(root, "value.txt"); await writeFile(file, "hello");
    const reader = await openHostFileReader(file);
    try {
      await expect(reader.readBytes({ maxBytes: -1 })).rejects.toBeInstanceOf(RangeError);
      const controller = new AbortController(); controller.abort();
      await expect(reader.readBytes({ maxBytes: 5, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(Buffer.from(await reader.readBytes({ maxBytes: 5 })).toString("utf8")).toBe("hello");
    } finally { await reader.close(); }
  });

  it("keeps the original bytes after its source junction is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-alias-")); roots.push(root);
    const inside = join(root, "inside"); const outside = join(root, "outside"); const alias = join(root, "alias");
    await mkdir(inside); await mkdir(outside);
    await writeFile(join(inside, "value.txt"), "INSIDE");
    await writeFile(join(outside, "value.txt"), "OUTSIDE");
    await symlink(inside, alias, process.platform === "win32" ? "junction" : "dir");
    const reader = await openHostFileReader(join(alias, "value.txt"));
    try {
      expect(reader.canonicalPath).toBe(await realpath(join(inside, "value.txt")));
      await rm(alias, { recursive: true });
      await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
      expect(Buffer.from(await reader.readBytes({ maxBytes: 20 })).toString("utf8")).toBe("INSIDE");
    } finally { await reader.close(); }
  });

  it("keeps missing and non-file errors distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-invalid-")); roots.push(root);
    await expect(openHostFileReader(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(openHostFileReader(root)).rejects.toMatchObject({ code: "EFTYPE" });
  });

  it("honors cancellation and closes the file when requested", async () => {
    const before = new AbortController(); before.abort();
    await expect(openHostFileReader("missing", before.signal)).rejects.toMatchObject({ name: "AbortError" });
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-close-")); roots.push(root);
    const file = join(root, "value.txt"); await writeFile(file, "hello");
    const reader = await openHostFileReader(file);
    const during = new AbortController(); during.abort();
    await expect(reader.readBytes({ maxBytes: 5, signal: during.signal })).rejects.toMatchObject({ name: "AbortError" });
    await reader.close();
    await reader.close();
    await expect(reader.readBytes({ maxBytes: 5 })).rejects.toMatchObject({ code: "EBADF" });
  });

  it.skipIf(process.platform !== "win32")("fails closed when a file has ambiguous hard-link names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-held-reader-hardlink-")); roots.push(root);
    const file = join(root, "value.txt"); await writeFile(file, "hello");
    await link(file, join(root, "another.txt"));
    await expect(openHostFileReader(file)).rejects.toMatchObject({ code: "ENOTSUP" });
  });
});
