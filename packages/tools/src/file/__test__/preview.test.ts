import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFileChange } from "../preview.js";
import { buildUnifiedDiff, computeToolDiff, truncateDiff } from "../diff.js";
import { HostFileOperations } from "../operations.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-preview-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("computeFileChange", () => {
  it("returns null for non Edit/Write tools", async () => {
    expect(await computeFileChange("Bash", { command: "ls" })).toBeNull();
    expect(await computeFileChange("Read", { file_path: "x" })).toBeNull();
  });

  it("Write: before is existing content, after is new content (no write)", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "old content", "utf-8");
    const change = await computeFileChange("Write", { file_path: p, content: "new content" });
    expect(change).toEqual({ path: p, before: "old content", after: "new content" });
    // 确认没写盘：文件仍是旧内容。
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(p, "utf-8")).toBe("old content");
  });

  it("Write: before is empty when file does not exist", async () => {
    const p = join(dir, "new.txt");
    const change = await computeFileChange("Write", { file_path: p, content: "hello" });
    expect(change).toEqual({ path: p, before: "", after: "hello" });
  });

  it("Write: returns null when fields missing", async () => {
    expect(await computeFileChange("Write", { file_path: 123 })).toBeNull();
    expect(await computeFileChange("Write", { content: "x" })).toBeNull();
  });

  it("Write: does not preview a replacement that explicit false or a stale hash forbids", async () => {
    const file = join(dir, "guarded.txt");
    await writeFile(file, "old");
    expect(await computeFileChange("Write", { file_path: file, content: "new", overwrite: false })).toBeNull();
    expect(await computeFileChange("Write", { file_path: file, content: "new",
      expected_sha256: createHash("sha256").update("not old").digest("hex") })).toBeNull();
    expect(await computeFileChange("Write", { file_path: file, content: "same", overwrite: "true" })).toBeNull();
  });

  it("Write: does not disguise a non-file or read failure as a new empty file", async () => {
    const folder = join(dir, "folder");
    await mkdir(folder);
    expect(await computeFileChange("Write", { file_path: folder, content: "new" })).toBeNull();
    const regularFile = join(dir, "data.txt");
    await writeFile(regularFile, "old");
    const read = vi.spyOn(HostFileOperations.prototype, "readBytes").mockRejectedValueOnce(Object.assign(new Error("read denied"), { code: "EACCES" }));
    try { expect(await computeFileChange("Write", { file_path: regularFile, content: "new" })).toBeNull(); }
    finally { read.mockRestore(); }
    expect(await computeFileChange("Write", { file_path: join(dir, "new.txt"), content: "new", expected_sha256: "0".repeat(64) })).toBeNull();
  });

  it("Edit: computes after by single replacement", async () => {
    const p = join(dir, "b.txt");
    await writeFile(p, "foo bar baz", "utf-8");
    const change = await computeFileChange("Edit", { file_path: p, old_string: "foo", new_string: "X" });
    expect(change).toEqual({ path: p, before: "foo bar baz", after: "X bar baz" });
  });

  it("Edit: replace_all replaces every occurrence", async () => {
    const p = join(dir, "c.txt");
    await writeFile(p, "a a a", "utf-8");
    const change = await computeFileChange("Edit", {
      file_path: p,
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(change!.after).toBe("b b b");
  });

  it("Edit: returns null when old_string not found", async () => {
    const p = join(dir, "d.txt");
    await writeFile(p, "hello", "utf-8");
    expect(await computeFileChange("Edit", { file_path: p, old_string: "nope", new_string: "x" })).toBeNull();
  });

  it("Edit: returns null on ambiguous match without replace_all", async () => {
    const p = join(dir, "e.txt");
    await writeFile(p, "x x", "utf-8");
    expect(await computeFileChange("Edit", { file_path: p, old_string: "x", new_string: "y" })).toBeNull();
  });

  it("Edit: returns null when file does not exist", async () => {
    const p = join(dir, "missing.txt");
    expect(await computeFileChange("Edit", { file_path: p, old_string: "a", new_string: "b" })).toBeNull();
  });
});

describe("buildUnifiedDiff", () => {
  it("produces unified diff body with +/- lines and no Index header", () => {
    const diff = buildUnifiedDiff("f.txt", "line1\nline2\n", "line1\nCHANGED\n");
    expect(diff).not.toContain("Index:");
    expect(diff).toContain("--- f.txt");
    expect(diff).toContain("+++ f.txt");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+CHANGED");
  });
});

describe("truncateDiff", () => {
  it("leaves short diffs untouched", () => {
    const d = "a\nb\nc";
    expect(truncateDiff(d, 10)).toBe(d);
  });

  it("truncates long diffs and appends a marker", () => {
    const d = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const out = truncateDiff(d, 10);
    const lines = out.split("\n");
    expect(lines).toHaveLength(11); // 10 kept + 1 marker
    expect(lines[10]).toContain("40 more line(s)");
  });
});

describe("computeToolDiff", () => {
  it("returns path + diff for an Edit", async () => {
    const p = join(dir, "g.txt");
    await writeFile(p, "alpha\nbeta\n", "utf-8");
    const res = await computeToolDiff("Edit", { file_path: p, old_string: "beta", new_string: "gamma" });
    expect(res).not.toBeNull();
    expect(res!.path).toBe(p);
    expect(res!.diff).toContain("-beta");
    expect(res!.diff).toContain("+gamma");
  });

  it("returns null when before === after (no real change)", async () => {
    const p = join(dir, "h.txt");
    await writeFile(p, "same", "utf-8");
    expect(await computeToolDiff("Write", { file_path: p, content: "same" })).toBeNull();
  });

  it("returns null for non-file tools", async () => {
    expect(await computeToolDiff("Bash", { command: "ls" })).toBeNull();
  });
});
