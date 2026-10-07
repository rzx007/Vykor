import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getDataDir, getLogsDir, getPluginCacheDir, getPluginDataDir, getTasksDir } from "@vykor/core";

import type { StorageCategory, StorageReport } from "@vykor/protocol";
export type { StorageCategory, StorageReport } from "@vykor/protocol";
export function maintenanceDirectories(storePath: string) {
  const root = dirname(resolve(storePath));
  return { attachments: join(root, "attachments"), memory: join(getDataDir(), "memory"), executionOutput: getTasksDir() };
}
export function scanStorage(storePath: string): StorageReport {
  if (!isAbsolute(storePath)) throw new Error("当前后台没有持久数据目录，不支持磁盘维护统计");
  const sources = maintenanceDirectories(storePath);
  const root = dirname(resolve(storePath));
  const definitions: Array<[string, string, string[]]> = [
    ["database", "会话数据库", [storePath, `${storePath}-wal`, `${storePath}-shm`, join(root, "notes")]],
    ["attachments", "附件（共享文件只计一次）", [sources.attachments]],
    ["memory", "项目和会话记忆", [sources.memory, join(getDataDir(), "session-memory")]], ["output", "运行输出", [sources.executionOutput]],
    ["logs", "日志", [getLogsDir()]], ["cache", "插件可重建缓存", [getPluginCacheDir()]],
    ["plugins", "插件用户数据", [getPluginDataDir()]],
  ];
  const seen = new Set<string>();
  const categories = definitions.map(([id, name, paths]): StorageCategory => {
    let bytes = 0; let files = 0; const errors: string[] = [];
    function walk(path: string) {
      if (!existsSync(path)) return;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { errors.push(`${path}：跳过链接，避免扫描外部目录`); return; }
        const key = `${stat.dev}:${stat.ino || realpathSync(path)}`;
        if (seen.has(key)) return; seen.add(key);
        if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
        else if (stat.isFile()) { bytes += stat.size; files++; }
        else errors.push(`${path}：不支持的文件类型`);
      } catch (error) { errors.push(`${path}：${error instanceof Error ? error.message : String(error)}`); }
    }
    paths.forEach(walk);
    return { id, name, paths, bytes, files, errors };
  });
  let writable = false; let availableBytes: number | null = null;
  try { accessSync(root, constants.W_OK); writable = true; } catch { /* reported as false */ }
  try { const space = statfsSync(root); availableBytes = space.bavail * space.bsize; } catch { /* unsupported filesystem */ }
  const historyDirectory = join(getDataDir(), "backup-audits");
  const backups: NonNullable<StorageReport["backups"]> = [];
  if (existsSync(historyDirectory)) for (const file of readdirSync(historyDirectory).filter(file => /^[\w-]+\.json$/.test(file))) {
    try { const record = JSON.parse(readFileSync(join(historyDirectory, file), "utf-8")); if (record.version === 1 && typeof record.path === "string" && record.manifest?.backupId) backups.push(record); } catch { /* malformed audit is not a valid backup */ }
  }
  return { scannedAt: Date.now(), dataDirectory: root, categories, writable, availableBytes, backups: backups.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50), totalBytes: categories.reduce((total, category) => total + category.bytes, 0) };
}
