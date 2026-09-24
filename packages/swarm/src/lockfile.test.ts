import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exclusiveFileLock, SwarmLockError } from "./lockfile.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vk-lock-"));
}

describe("exclusiveFileLock", () => {
  it("runs fn, returns its value, and removes the lock file afterwards", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, ".write_lock");
    try {
      const result = await exclusiveFileLock(lockPath, async () => 42);
      expect(result).toBe(42);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories for the lock path", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "deep", "nested", ".lock");
    try {
      const result = await exclusiveFileLock(lockPath, () => "ok");
      expect(result).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent critical sections (mutual exclusion)", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, ".write_lock");
    try {
      let inside = 0;
      let maxInside = 0;
      const critical = async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 30));
        inside -= 1;
      };
      await Promise.all([
        exclusiveFileLock(lockPath, critical),
        exclusiveFileLock(lockPath, critical),
        exclusiveFileLock(lockPath, critical),
      ]);
      expect(maxInside).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases the lock when fn throws, so the next acquire succeeds", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, ".write_lock");
    try {
      await expect(
        exclusiveFileLock(lockPath, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(lockPath)).toBe(false);
      // 再次获取应直接成功，不等待陈旧回收。
      const result = await exclusiveFileLock(lockPath, () => "again");
      expect(result).toBe("again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steals a stale lock left behind by a crashed holder", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, ".write_lock");
    try {
      writeFileSync(lockPath, "");
      // 把 mtime 拨回 60s 前，模拟持有者崩溃残留。
      const past = (Date.now() - 60_000) / 1000;
      utimesSync(lockPath, past, past);
      const result = await exclusiveFileLock(lockPath, () => "stolen", {
        staleMs: 1_000,
        timeoutMs: 2_000,
      });
      expect(result).toBe("stolen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws SwarmLockError when the lock stays held past timeoutMs", async () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, ".write_lock");
    try {
      writeFileSync(lockPath, ""); // 新鲜锁文件，且 staleMs 足够大不会被回收
      await expect(
        exclusiveFileLock(lockPath, () => "never", {
          staleMs: 60_000,
          timeoutMs: 300,
          retryIntervalMs: 50,
        }),
      ).rejects.toThrow(SwarmLockError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
