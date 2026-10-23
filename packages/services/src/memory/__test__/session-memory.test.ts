import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  getSessionMemoryDir,
  getSessionMemoryPath,
  buildSessionMemoryDocument,
  updateSessionMemoryFile,
  getSessionMemoryContent,
  sessionMemoryToCompactText,
  MAX_SESSION_MEMORY_CHARS,
} from "../session-memory.js";

let cfgDir: string;
let projDir: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "vk-sm-cfg-"));
  projDir = mkdtempSync(join(tmpdir(), "vk-sm-proj-"));
  process.env.VYKOR_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  delete process.env.VYKOR_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("paths", () => {
  it("dir is <dataDir>/session-memory/<projname>-<sha1cwd12> and is stable", () => {
    const dir1 = getSessionMemoryDir(projDir);
    const dir2 = getSessionMemoryDir(projDir);
    expect(dir1).toBe(dir2);
    expect(dir1).toContain(join("session-memory", basename(projDir)));
    expect(dir1).toMatch(/-[0-9a-f]{12}$/);
    expect(existsSync(dir1)).toBe(true);
  });

  it("session id is sanitized for the filename", () => {
    const path = getSessionMemoryPath(projDir, "se ss/ion:1");
    expect(basename(path)).toBe("se_ss_ion_1.md");
    expect(basename(getSessionMemoryPath(projDir))).toBe("default.md");
  });
});

describe("buildSessionMemoryDocument", () => {
  it("renders task focus state and recent messages", () => {
    const doc = buildSessionMemoryDocument(
      [
        { role: "user", content: "fix the auth bug please" },
        { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
        { role: "tool_result", content: [{ type: "tool_result", content: "..." }] },
      ],
      {
        toolMetadata: {
          task_focus_state: {
            goal: "Fix auth bug",
            next_step: "Run tests",
            verified_state: ["null check added"],
            active_artifacts: ["src/auth.ts"],
          },
        },
      },
    );
    expect(doc).toContain("# Session Memory");
    expect(doc).toContain("## Current State\nFix auth bug");
    expect(doc).toContain("## Next Step\nRun tests");
    expect(doc).toContain("- null check added");
    expect(doc).toContain("- src/auth.ts");
    expect(doc).toContain("- user: fix the auth bug please");
    expect(doc).toContain("tool calls -> Read");
    expect(doc).toContain("tool results returned");
  });

  it("falls back gracefully without state and truncates at the budget", () => {
    const doc = buildSessionMemoryDocument([], {});
    expect(doc).toContain("(no current goal recorded)");
    expect(doc).toContain("- (no recent messages)");

    const huge = buildSessionMemoryDocument(
      Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i} ${"y".repeat(300)}` })),
      {},
    );
    expect(huge.length).toBeLessThanOrEqual(MAX_SESSION_MEMORY_CHARS + 100);
    expect(huge).toContain("truncated to stay within budget");
  });

  it("keeps the latest conversation when the checkpoint exceeds its budget", () => {
    const doc = buildSessionMemoryDocument(
      Array.from({ length: 80 }, (_, i) => ({
        role: "user",
        content: `message-${i} ${"x".repeat(210)}`,
      })),
    );

    expect(doc).toContain("message-79");
    expect(doc).not.toContain("message-0");
    expect(doc.length).toBeLessThanOrEqual(MAX_SESSION_MEMORY_CHARS + 100);
  });
});

describe("update / read / compact text", () => {
  it("writes the checkpoint, records the path in toolMetadata, reads back", () => {
    const meta: Record<string, unknown> = { session_id: "s1" };
    const path = updateSessionMemoryFile(projDir, [{ role: "user", content: "hello world" }], {
      toolMetadata: meta,
    });
    expect(meta.session_memory_path).toBe(path);
    expect(readFileSync(path, "utf-8")).toContain("hello world");
    expect(getSessionMemoryContent(path)).toContain("hello world");
    expect(getSessionMemoryContent(undefined)).toBe("");
    expect(getSessionMemoryContent(join(projDir, "nope.md"))).toBe("");
  });

  it("sessionMemoryToCompactText wraps non-empty content with the header", () => {
    expect(sessionMemoryToCompactText("")).toBe("");
    const wrapped = sessionMemoryToCompactText("# Session Memory\nstuff");
    expect(wrapped.startsWith("Session memory checkpoint from earlier in this conversation:")).toBe(true);
    expect(wrapped).toContain("stuff");
  });
});
