import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";

import { getDataDir } from "@vykor/core";
import { LOCK_FILE } from "./lock.js";

/**
 * autodream 备份/差异/还原（移植自 Python autodream/backup.py）。
 * dream 跑前整目录备份，失败可还原；完成后 diff 出 added/changed/removed。
 */

export function defaultBackupRoot(appLabel = "vykor"): string {
  const safeLabel = appLabel.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "vykor";
  return join(getDataDir(), "memory-backups", safeLabel);
}

/** 时间戳目录整份拷贝（跳过锁文件）；目录不存在则建空备份。 */
export function createMemoryBackup(
  memoryDir: string,
  options?: { backupRoot?: string; appLabel?: string },
): string {
  const root = options?.backupRoot ?? defaultBackupRoot(options?.appLabel);
  mkdirSync(root, { recursive: true });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `memory-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let backup = join(root, timestamp);
  let suffix = 1;
  while (existsSync(backup)) {
    suffix += 1;
    backup = join(root, `${timestamp}-${suffix}`);
  }
  if (existsSync(memoryDir)) {
    cpSync(memoryDir, backup, {
      recursive: true,
      filter: (src) => basename(src) !== LOCK_FILE,
    });
  } else {
    mkdirSync(backup, { recursive: true });
  }
  return backup;
}

function mdFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) map.set(name, join(dir, name));
  }
  return map;
}

/** 两个 memory 目录的 .md 文件差异（按内容比较）。 */
export function diffMemoryDirs(before: string, after: string): { added: string[]; removed: string[]; changed: string[] } {
  const beforeFiles = mdFiles(resolve(before));
  const afterFiles = mdFiles(resolve(after));
  const added = [...afterFiles.keys()].filter((n) => !beforeFiles.has(n)).sort();
  const removed = [...beforeFiles.keys()].filter((n) => !afterFiles.has(n)).sort();
  const changed = [...beforeFiles.keys()]
    .filter((n) => afterFiles.has(n))
    .filter((n) => {
      try {
        return readFileSync(beforeFiles.get(n)!, "utf-8") !== readFileSync(afterFiles.get(n)!, "utf-8");
      } catch {
        return true;
      }
    })
    .sort();
  return { added, removed, changed };
}

export function formatMemoryDiff(diff: { added: string[]; removed: string[]; changed: string[] }): string {
  const lines: string[] = [];
  for (const label of ["added", "changed", "removed"] as const) {
    if (diff[label].length > 0) lines.push(`${label}: ${diff[label].join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : "no markdown file changes";
}

export function latestMemoryBackup(appLabel = "vykor"): string | null {
  const root = defaultBackupRoot(appLabel);
  if (!existsSync(root)) return null;
  const backups = readdirSync(root)
    .filter((name) => name.startsWith("memory-"))
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
  if (backups.length === 0) return null;
  return backups.reduce((latest, path) =>
    statSync(path).mtimeMs > statSync(latest).mtimeMs ? path : latest,
  );
}

/** 从备份整目录还原（先拷到 .restore-tmp 再原子换名）。 */
export function restoreMemoryBackup(backupDir: string, memoryDir: string): void {
  if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
    throw new Error(`Backup not found: ${backupDir}`);
  }
  const tmp = join(memoryDir, "..", `.${basename(memoryDir)}.restore-tmp`);
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  cpSync(backupDir, tmp, { recursive: true });
  if (existsSync(memoryDir)) rmSync(memoryDir, { recursive: true, force: true });
  renameSync(tmp, memoryDir);
}
