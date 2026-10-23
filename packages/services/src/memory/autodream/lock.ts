import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * autodream 整合锁（移植自 Python autodream/lock.py）。
 *
 * 锁文件 `.consolidate-lock` 放在 memory 目录内，内容是持有者 PID：
 * - mtime 即「上次整合时间」（成功后留下的戳）；
 * - 1 小时内且持有者进程仍活着 → 视为占用；
 * - 失败/被杀的 dream 经 rollback 把 mtime 拨回原值（不影响下次触发节奏）。
 */

export const LOCK_FILE = ".consolidate-lock";
export const HOLDER_STALE_SECONDS = 60 * 60;

const lockPath = (memoryDir: string): string => join(memoryDir, LOCK_FILE);

/** 锁文件 mtime = 上次成功整合时间；不存在返回 0。 */
export function readLastConsolidatedAt(memoryDir: string): number {
  try {
    return statSync(lockPath(memoryDir)).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

function holderPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/** 抢整合锁：成功返回先前 mtime（秒，0 表示首次），被占返回 null。 */
export function tryAcquireConsolidationLock(memoryDir: string): number | null {
  const path = lockPath(memoryDir);
  let priorMtime: number | null = null;
  let holder: number | null = null;
  try {
    priorMtime = statSync(path).mtimeMs / 1000;
    holder = holderPid(path);
  } catch {
    holder = null;
  }

  if (priorMtime !== null && Date.now() / 1000 - priorMtime < HOLDER_STALE_SECONDS) {
    if (holder !== null && isProcessRunning(holder)) return null;
  }

  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${process.pid}\n`);
  if (holderPid(path) !== process.pid) return null;
  return priorMtime ?? 0;
}

/** dream 失败/被杀后回滚锁 mtime（best-effort，失败只是推迟下次自动触发）。 */
export function rollbackConsolidationLock(memoryDir: string, priorMtime: number): void {
  const path = lockPath(memoryDir);
  try {
    if (priorMtime <= 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    atomicWrite(path, "");
    utimesSync(path, priorMtime, priorMtime);
  } catch {
    // best-effort
  }
}

/** 手动整合后打时间戳。 */
export function recordConsolidation(memoryDir: string): void {
  const path = lockPath(memoryDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${process.pid}\n`);
}
