import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { grepTool } from "../grep.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "oh-grep-"));
}

describe("grepTool", () => {
  it("finds matching lines", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "hello\nworld\nfindme here\n");
      const result = await grepTool.execute!(
        { pattern: "findme", path: dir },
        { cwd: dir }
      );
      const text = (result.content[0] as any).text as string;
      expect(text).toContain("findme here");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips lines longer than 64KB instead of crashing", async () => {
    const dir = await makeTmpDir();
    try {
      // One pathological 200KB line containing the pattern (must be skipped),
      // followed by a short line that also matches (must be returned).
      const hugeLine = "x".repeat(200 * 1024) + "needle";
      const content = `${hugeLine}\nshort needle line\n`;
      await fs.writeFile(path.join(dir, "big.txt"), content);

      const result = await grepTool.execute!(
        { pattern: "needle", path: dir },
        { cwd: dir }
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as any).text as string;
      // The short line is returned...
      expect(text).toContain("short needle line");
      // ...but the 200KB line is not (no giant blob in the output).
      expect(text.length).toBeLessThan(50 * 1024);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns (no matches) when nothing matches", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "nothing interesting\n");
      const result = await grepTool.execute!(
        { pattern: "zzz_absent_zzz", path: dir },
        { cwd: dir }
      );
      const text = (result.content[0] as any).text as string;
      expect(text).toBe("(no matches)");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects the limit", async () => {
    const dir = await makeTmpDir();
    try {
      const lines = Array.from({ length: 50 }, (_, i) => `match ${i}`).join("\n");
      await fs.writeFile(path.join(dir, "many.txt"), lines + "\n");
      const result = await grepTool.execute!(
        { pattern: "match", path: dir, limit: 5 },
        { cwd: dir }
      );
      const text = (result.content[0] as any).text as string;
      expect(text.split("\n").filter((line) => /:\d+:/.test(line))).toHaveLength(5);
      expect(text).toMatch(/limited|truncated/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, Number.NaN, 201, null])("rejects invalid limit %s", async (limit) => {
    const result = await grepTool.execute({ pattern: "needle", limit }, { cwd: process.cwd() });
    expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });

  it("does not search when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await grepTool.execute({ pattern: "needle" }, { cwd: process.cwd(), abortSignal: controller.signal });
    expect(result).toMatchObject({ isError: true, failureKind: "interrupted" });
  });

  it("bounds UTF-8 output and reports truncation", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "long.txt"), ("needle " + "中文😀".repeat(400) + "\n").repeat(10));
      const result = await grepTool.execute({ pattern: "needle", path: dir }, { cwd: dir });
      const text = (result.content[0] as { text: string }).text;
      expect(result.isError).toBeFalsy();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
      expect(text).toContain("needle");
      expect(text).not.toContain("�");
      expect(text).toMatch(/limited|truncated/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves matching line whitespace", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "  needle  \r\n");
      const result = await grepTool.execute({ pattern: "needle", path: dir }, { cwd: dir });
      expect((result.content[0] as { text: string }).text).toMatch(/:1:  needle  $/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
