import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { loadOutputStyles, getOutputStylesDir, isKnownOutputStyle } from "./index.js";

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

describe("getOutputStylesDir", () => {
  it("points at ~/.vykor/output_styles", () => {
    expect(getOutputStylesDir()).toBe(join(homedir(), ".vykor", "output_styles"));
  });
});

// 用户样式加载:把一个 .md 放进真实的 output_styles 目录,断言被加载为 source=user,用后清理。
describe("loadOutputStyles (user .md)", () => {
  const dir = getOutputStylesDir();
  let tmpName: string;

  beforeEach(() => {
    // 用唯一文件名避免与真实用户样式冲突。
    const stamp = mkdtempSync(join(tmpdir(), "os-")).split(/[\\/]/).pop()!;
    tmpName = `__test_${stamp}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${tmpName}.md`), "My custom style.", "utf-8");
  });
  afterEach(() => {
    try {
      rmSync(join(dir, `${tmpName}.md`));
    } catch {
      /* ignore */
    }
  });

  it("loads a user .md as source=user with file content", () => {
    const styles = loadOutputStyles();
    const mine = styles.find((s) => s.name === tmpName);
    expect(mine).toBeDefined();
    expect(mine!.source).toBe("user");
    expect(mine!.content).toBe("My custom style.");
  });
});
