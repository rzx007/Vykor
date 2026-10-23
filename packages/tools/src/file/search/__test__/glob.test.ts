import {createGlobTool} from "../glob.js";
import {executeToolFixture} from "../../../../test-helpers/tool-host-fixture.js";

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { globTool } from "../glob.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "oh-glob-"));
}

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function lines(result: Awaited<ReturnType<NonNullable<typeof globTool.execute>>>): string[] {
  const text = (result.content[0] as any).text as string;
  if (text === "No files matched.") return [];
  return text.split("\n");
}

describe("globTool", () => {
  it("matches files by pattern", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "a.ts"), "");
      await fs.writeFile(path.join(dir, "b.js"), "");
      const result = await executeToolFixture(host => createGlobTool(host), { pattern: "**/*.ts", path: dir }, { cwd: dir });
      const out = lines(result);
      expect(out.some((l) => l.endsWith("a.ts"))).toBe(true);
      expect(out.some((l) => l.endsWith("b.js"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips node_modules and .venv (heavy dirs) in the Node fallback", async () => {
    // This exercises the pure-Node walker behavior, which is what runs when
    // ripgrep is unavailable. It is cross-platform and does not depend on rg.
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "keep.ts"), "");
      await fs.mkdir(path.join(dir, "node_modules"));
      await fs.writeFile(path.join(dir, "node_modules", "dep.ts"), "");
      await fs.mkdir(path.join(dir, ".venv"));
      await fs.writeFile(path.join(dir, ".venv", "lib.ts"), "");

      const result = await executeToolFixture(host => createGlobTool(host), { pattern: "**/*.ts", path: dir }, { cwd: dir });
      const out = lines(result);
      expect(out.some((l) => l.endsWith("keep.ts"))).toBe(true);
      // Even if rg is present it honors .gitignore defaults but not arbitrary
      // node_modules without a .gitignore; the assertion below targets the
      // Node fallback path. Skip the negative assertion when rg is installed.
      if (!hasRipgrep()) {
        expect(out.some((l) => l.includes("node_modules"))).toBe(false);
        expect(out.some((l) => l.includes(".venv"))).toBe(false);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects .gitignore (ripgrep path only)", async () => {
    if (!hasRipgrep()) {
      // The Node fallback does not parse .gitignore; this behavior is provided
      // by ripgrep. Skip when rg is unavailable (e.g. this CI machine).
      return;
    }
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, ".gitignore"), "ignored.ts\n");
      await fs.writeFile(path.join(dir, "kept.ts"), "");
      await fs.writeFile(path.join(dir, "ignored.ts"), "");

      const result = await executeToolFixture(host => createGlobTool(host), { pattern: "**/*.ts", path: dir }, { cwd: dir });
      const out = lines(result);
      expect(out.some((l) => l.endsWith("kept.ts"))).toBe(true);
      expect(out.some((l) => l.endsWith("ignored.ts"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects the limit", async () => {
    const dir = await makeTmpDir();
    try {
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(path.join(dir, `f${i}.ts`), "");
      }
      const result = await executeToolFixture(host => createGlobTool(host), { pattern: "**/*.ts", path: dir, limit: 5 }, { cwd: dir });
      const out = lines(result);
      expect(out.length).toBe(5);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
