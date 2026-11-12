import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOutputStyles, isKnownOutputStyle } from "../index.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("output styles in the selected root", () => {
  it("loads target content without reading or modifying the old home style", () => {
    const base = mkdtempSync(join(tmpdir(), "vykor-styles-")); directories.push(base);
    const home = join(base, "home"), root = join(base, "selected");
    const oldDir = join(home, ".vykor", "output_styles"), targetDir = join(root, "output_styles");
    mkdirSync(oldDir, { recursive: true }); mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(oldDir, "same.md"), "old home"); writeFileSync(join(targetDir, "same.md"), "selected root");
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("VYKOR_CONFIG_DIR", root);
    const before = readdirSync(oldDir);
    const styles = loadOutputStyles();
    expect(styles.find(style => style.name === "same")?.content).toBe("selected root");
    expect(styles.slice(0, 3).map(style => style.name)).toEqual(["default", "minimal", "codex"]);
    expect(isKnownOutputStyle("same", styles)).toBe(true);
    expect(isKnownOutputStyle("unknown", styles)).toBe(false);
    expect(readdirSync(oldDir)).toEqual(before);
    expect(readFileSync(join(oldDir, "same.md"), "utf8")).toBe("old home");
  });
});

describe("loadOutputStyles (builtin)", () => {
  it("includes the three builtin styles", () => {
    const styles = loadOutputStyles();
    const names = styles.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["default", "minimal", "codex"]));
  });

  it("marks builtin styles with source=builtin", () => {
    const styles = loadOutputStyles();
    for (const name of ["default", "minimal", "codex"]) {
      const s = styles.find((x) => x.name === name)!;
      expect(s.source).toBe("builtin");
      expect(s.content.length).toBeGreaterThan(0);
    }
  });

  it("builtins come first and in fixed order", () => {
    const styles = loadOutputStyles();
    expect(styles.slice(0, 3).map((s) => s.name)).toEqual(["default", "minimal", "codex"]);
  });
});

describe("isKnownOutputStyle", () => {
  it("accepts builtin names and rejects unknown", () => {
    const styles = loadOutputStyles();
    expect(isKnownOutputStyle("minimal", styles)).toBe(true);
    expect(isKnownOutputStyle("nope", styles)).toBe(false);
  });
});
