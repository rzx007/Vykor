import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings } from "@vykor/core";
import type { DetachedProcessExecution } from "../../executions/index.js";
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  createMemoryBackup,
  diffMemoryDirs,
  formatMemoryDiff,
  restoreMemoryBackup,
  buildConsolidationPrompt,
  startDreamNow,
  executeAutoDream,
  _resetAutodreamStateForTests,
  LOCK_FILE,
  type DreamTaskRunner,
} from "../index.js";

let tmp: string;
let memoryDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vk-dream-"));
  memoryDir = join(tmp, "memory");
  mkdirSync(memoryDir, { recursive: true });
  process.env.VYKOR_CONFIG_DIR = join(tmp, "cfg");
  delete process.env.VYKOR_AUTODREAM_CHILD;
  _resetAutodreamStateForTests();
});

afterEach(() => {
  delete process.env.VYKOR_CONFIG_DIR;
  delete process.env.VYKOR_AUTODREAM_CHILD;
  rmSync(tmp, { recursive: true, force: true });
});

function settings(memory?: Settings["memory"]): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 50,
    permission: { mode: "default" },
    memory,
  } as Settings;
}

function fakeRunner(): DreamTaskRunner & { tasks: DetachedProcessExecution[]; fire: (task: DetachedProcessExecution, event: string) => void } {
  const listeners: Array<(task: DetachedProcessExecution, event: string) => void> = [];
  const tasks: DetachedProcessExecution[] = [];
  return {
    tasks,
    async startShellExecution(options) {
      const task = {
        id: `task_${tasks.length + 1}`,
        type: "dream",
        status: "running",
        description: options.description,
        cwd: options.cwd,
        argv: options.argv,
        env: options.env,
        createdAt: Date.now(),
        metadata: {},
      } as unknown as DetachedProcessExecution;
      tasks.push(task);
      return task;
    },
    registerExecutionListener(listener) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    fire(task, event) {
      for (const l of [...listeners]) l(task, event);
    },
  };
}

describe("consolidation lock", () => {
  it("acquire returns prior mtime, blocks while held by a live process, rollback restores", () => {
    expect(readLastConsolidatedAt(memoryDir)).toBe(0);
    const prior = tryAcquireConsolidationLock(memoryDir);
    expect(prior).toBe(0);
    // 自己持有（PID 是本进程且 1h 内）→ Python 语义:同进程视为 running → 占用。
    expect(tryAcquireConsolidationLock(memoryDir)).toBeNull();

    // 回滚到 0 → 锁文件删除。
    rollbackConsolidationLock(memoryDir, 0);
    expect(existsSync(join(memoryDir, LOCK_FILE))).toBe(false);

    // 回滚到具体时间 → mtime 还原。
    const t = tryAcquireConsolidationLock(memoryDir);
    expect(t).toBe(0);
    rollbackConsolidationLock(memoryDir, 1700000000);
    expect(Math.round(readLastConsolidatedAt(memoryDir))).toBe(1700000000);
  });

  it("steals a stale lock from a dead holder", () => {
    const lockPath = join(memoryDir, LOCK_FILE);
    writeFileSync(lockPath, "999999\n"); // 几乎必然不存在的 PID
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000; // 2h 前 → 超过 stale 阈值
    utimesSync(lockPath, past, past);
    expect(tryAcquireConsolidationLock(memoryDir)).not.toBeNull();
  });
});

describe("backup / diff / restore", () => {
  it("backs up md files (skipping the lock), diffs content, restores", () => {
    writeFileSync(join(memoryDir, "a.md"), "A1");
    writeFileSync(join(memoryDir, "b.md"), "B");
    writeFileSync(join(memoryDir, LOCK_FILE), "123");

    const backup = createMemoryBackup(memoryDir);
    expect(existsSync(join(backup, "a.md"))).toBe(true);
    expect(existsSync(join(backup, LOCK_FILE))).toBe(false);

    writeFileSync(join(memoryDir, "a.md"), "A2"); // changed
    rmSync(join(memoryDir, "b.md")); // removed
    writeFileSync(join(memoryDir, "c.md"), "C"); // added

    const diff = diffMemoryDirs(backup, memoryDir);
    expect(diff).toEqual({ added: ["c.md"], removed: ["b.md"], changed: ["a.md"] });
    expect(formatMemoryDiff(diff)).toContain("added: c.md");
    expect(formatMemoryDiff({ added: [], removed: [], changed: [] })).toBe("no markdown file changes");

    restoreMemoryBackup(backup, memoryDir);
    expect(readFileSync(join(memoryDir, "a.md"), "utf-8")).toBe("A1");
    expect(existsSync(join(memoryDir, "b.md"))).toBe(true);
    expect(existsSync(join(memoryDir, "c.md"))).toBe(false);
  });
});

describe("buildConsolidationPrompt", () => {
  it("contains the policy sections, mode switch, and extra context", () => {
    const apply = buildConsolidationPrompt("/mem", "extra stuff");
    expect(apply).toContain("# Dream: Memory Consolidation");
    expect(apply).toContain("APPLY MODE");
    expect(apply).toContain("Never preserve API keys");
    expect(apply).toContain("## Additional context\n\nextra stuff");
    expect(buildConsolidationPrompt("/mem", "", { preview: true })).toContain("PREVIEW MODE");
  });
});

describe("startDreamNow", () => {
  const mem = { enabled: true, autoDreamEnabled: true };

  it("force-starts a dream: lock acquired, backup made, argv carries the prompt", async () => {
    writeFileSync(join(memoryDir, "a.md"), "A");
    const runner = fakeRunner();
    const task = await startDreamNow({
      cwd: tmp,
      settings: settings(mem),
      memoryDir,
      recentSessionIds: ["older-session"],
      force: true,
      taskRunner: runner,
      cliEntry: "/cli.js",
      staleSection: "- old-memory.md",
    });
    expect(task).not.toBeNull();
    expect(task!.env?.VYKOR_AUTODREAM_CHILD).toBe("1");
    const argv = task!.argv!;
    expect(argv).toContain("--print");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).toContain("Dream: Memory Consolidation");
    expect(argv.join(" ")).toContain("- old-memory.md");
    expect(task!.metadata.backup_dir).not.toBe("");
    // 锁已被持有：再次启动被拒。
    expect(
      await startDreamNow({ cwd: tmp, settings: settings(mem), memoryDir, force: true, taskRunner: runner, cliEntry: "/cli.js" }),
    ).toBeNull();
  });

  it("refuses inside a dream child process and when memory is disabled", async () => {
    const runner = fakeRunner();
    process.env.VYKOR_AUTODREAM_CHILD = "1";
    expect(
      await startDreamNow({ cwd: tmp, settings: settings(mem), memoryDir, force: true, taskRunner: runner }),
    ).toBeNull();
    delete process.env.VYKOR_AUTODREAM_CHILD;
    expect(
      await startDreamNow({ cwd: tmp, settings: settings({ enabled: false }), memoryDir, force: true, taskRunner: runner }),
    ).toBeNull();
  });

  it("rolls back the lock when the dream task fails", async () => {
    const runner = fakeRunner();
    const task = (await startDreamNow({
      cwd: tmp,
      settings: settings(mem),
      memoryDir,
      force: true,
      taskRunner: runner,
      cliEntry: "/cli.js",
    }))!;
    (task as { status: string }).status = "failed";
    runner.fire(task, "completed");
    // 锁回滚到 0 → 文件删除 → 可再次获取。
    expect(existsSync(join(memoryDir, LOCK_FILE))).toBe(false);
  });
});

describe("executeAutoDream", () => {
  it("uses durable recent session ids instead of scanning session JSON files", async () => {
    const runner = fakeRunner();
    const task = await executeAutoDream({
      cwd: tmp,
      settings: settings({
        enabled: true,
        autoDreamEnabled: true,
        autoDreamMinHours: 0,
        autoDreamMinSessions: 2,
      }),
      memoryDir,
      recentSessionIds: ["s1", "s2", "s2"],
      taskRunner: runner,
      cliEntry: "/cli.js",
    });

    expect(task).not.toBeNull();
    expect(task!.argv!.join(" ")).toContain("Sessions since last consolidation (2)");
  });
});
