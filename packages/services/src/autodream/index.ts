import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Settings } from "@vykor/core";
import {
  getDetachedProcessSupervisor,
  type DetachedProcessExecution,
} from "../executions/index.js";
import {
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from "./lock.js";
import { createMemoryBackup, diffMemoryDirs } from "./backup.js";
import { buildConsolidationPrompt } from "./prompt.js";

export {
  LOCK_FILE,
  HOLDER_STALE_SECONDS,
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  recordConsolidation,
} from "./lock.js";
export {
  defaultBackupRoot,
  createMemoryBackup,
  diffMemoryDirs,
  formatMemoryDiff,
  latestMemoryBackup,
  restoreMemoryBackup,
} from "./backup.js";
export { buildConsolidationPrompt, MAX_ENTRYPOINT_LINES, ENTRYPOINT_NAME } from "./prompt.js";

/**
 * Auto-dream 服务（移植自 Python autodream/service.py）。
 *
 * dream = 拉一个 `vk --print <整合 prompt>` 子进程（type:"dream"），让模型
 * 反思性地重组 memory 目录。跑前整目录备份 + 抢整合锁；失败/被杀回滚锁 mtime。
 *
 * 与 Python 差异：① argv 不带 api-key（TS teammate 同约定，key 走 settings/env）；
 * ② stale 候选由调用方经 staleSection 传入（TS MemoryManager.findStaleCandidates
 *   是实例方法，服务层不持有实例）；③ runner 只有 vykor 形态（无 ohmo）。
 */

const CHILD_ENV = "VYKOR_AUTODREAM_CHILD";
const SESSION_SCAN_INTERVAL_SECONDS = 10 * 60;
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 3;

const lastSessionScanAt = new Map<string, number>();

/** AutoDream 需要的最小后台进程执行面（测试可注入 fake）。 */
export interface DreamTaskRunner {
  startShellExecution(options: {
    argv: string[];
    description: string;
    cwd: string;
    env?: Record<string, string>;
    type?: string;
    settings?: Settings;
  }): Promise<DetachedProcessExecution>;
  registerExecutionListener(listener: (task: DetachedProcessExecution, event: string) => void): () => void;
  /** 取活任务对象（监听器收到的是快照；缺省实现可不提供）。 */
  getExecution?(id: string): DetachedProcessExecution | undefined;
}

export interface StartDreamOptions {
  cwd: string;
  settings: Settings;
  memoryDir: string;
  /** Durable Application sessions updated since the last consolidation. */
  recentSessionIds?: string[];
  model?: string;
  currentSessionId?: string;
  force?: boolean;
  preview?: boolean;
  appLabel?: string;
  /** 用量型 stale 候选清单（一行一条），进整合 prompt 的附加上下文。 */
  staleSection?: string;
  taskRunner?: DreamTaskRunner;
  /** CLI 入口（缺省 process.argv[1]，与 teammate 同写法）。 */
  cliEntry?: string;
}

function memoryFilesMtimeSnapshot(memoryDir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith(".md")) continue;
      try {
        snapshot.set(name, statSync(join(memoryDir, name)).mtimeMs);
      } catch {
        continue;
      }
    }
  } catch {
    // 目录不存在按空集
  }
  return snapshot;
}

function filesChangedSince(memoryDir: string, before: Map<string, number>): string[] {
  const changed: string[] = [];
  try {
    for (const name of readdirSync(memoryDir).sort()) {
      if (!name.endsWith(".md")) continue;
      try {
        if (before.get(name) !== statSync(join(memoryDir, name)).mtimeMs) changed.push(name);
      } catch {
        continue;
      }
    }
  } catch {
    // 目录不存在按无变化
  }
  return changed;
}

/** 立即起一次 dream（force 可跳过时间/会话数门槛）。被占/被禁/子进程内返回 null。 */
export async function startDreamNow(options: StartDreamOptions): Promise<DetachedProcessExecution | null> {
  if (process.env[CHILD_ENV]) return null;
  if (!options.settings.memory?.enabled) return null;

  const cwd = resolve(options.cwd);
  const memoryDir = resolve(options.memoryDir);
  const memCfg = options.settings.memory;

  const lastAt = readLastConsolidatedAt(memoryDir);
  const sessionIds = [...new Set(options.recentSessionIds ?? [])];
  if (!options.force) {
    const hoursSince = (Date.now() / 1000 - lastAt) / 3600;
    if (hoursSince < (memCfg.autoDreamMinHours ?? DEFAULT_MIN_HOURS)) return null;
    if (sessionIds.length < (memCfg.autoDreamMinSessions ?? DEFAULT_MIN_SESSIONS)) return null;
    if (sessionIds.length === 0) return null;
  }

  const priorMtime = tryAcquireConsolidationLock(memoryDir);
  if (priorMtime === null) return null;

  const runner = options.taskRunner ?? getDetachedProcessSupervisor(cwd);
  mkdirSync(memoryDir, { recursive: true });
  const before = memoryFilesMtimeSnapshot(memoryDir);
  const backupDir = options.preview
    ? null
    : createMemoryBackup(memoryDir, { appLabel: options.appLabel });

  const extra =
    `Application context: \`${options.appLabel ?? "vykor"}\`.\n` +
    "Tool constraints for this run: only modify files under the memory directory. " +
    "Use shell commands only for read-only inspection.\n\n" +
    `Sessions since last consolidation (${sessionIds.length}):\n` +
    sessionIds.slice(0, 200).map((id) => `- ${id}`).join("\n") +
    (sessionIds.length > 200 ? `\n- ... and ${sessionIds.length - 200} more` : "") +
    "\n\nUsage-based stale candidates:\n" +
    (options.staleSection?.trim() || "- (none)");
  const prompt = buildConsolidationPrompt(memoryDir, extra, { preview: options.preview });

  const env: Record<string, string> = {
    [CHILD_ENV]: "1",
    VYKOR_AUTODREAM_MEMORY_DIR: memoryDir,
  };
  const settings = options.settings;
  const cliEntry = options.cliEntry ?? process.argv[1] ?? "";
  const argv = [process.execPath, cliEntry, "--print", prompt, "--dangerously-skip-permissions"];
  if (options.model ?? settings.model) argv.push("--model", options.model ?? settings.model);
  if (settings.provider) argv.push("--provider", settings.provider);
  if (settings.baseUrl) argv.push("--base-url", settings.baseUrl);
  if (settings.apiFormat) argv.push("--api-format", settings.apiFormat);

  // 完成监听先于 spawn 注册（对齐 Python 时序）：子进程秒退也不漏回滚。
  // 同一 memoryDir 的 dream 被锁互斥，env 标记可唯一定位本任务。
  const unregister = runner.registerExecutionListener((done, event) => {
    if (event !== "completed") return;
    if (done.type !== "dream" || done.env?.VYKOR_AUTODREAM_MEMORY_DIR !== memoryDir) return;
    unregister();
    const status = done.status as string;
    if (status === "failed" || status === "stopped" || (done.exitCode ?? 0) !== 0 || options.preview) {
      rollbackConsolidationLock(memoryDir, priorMtime);
      return;
    }
    // 监听器拿到的是快照：取活任务再写 metadata（getTask 可选）。
    const live = runner.getExecution?.(done.id) ?? done;
    const changed = filesChangedSince(memoryDir, before);
    if (backupDir) {
      const diff = diffMemoryDirs(backupDir, memoryDir);
      live.metadata.files_added = diff.added.join("\n");
      live.metadata.files_changed = diff.changed.join("\n");
      live.metadata.files_removed = diff.removed.join("\n");
    }
    if (changed.length > 0) {
      live.metadata.phase = "updating";
      live.metadata.files_touched = changed.join("\n");
    }
  });

  let task: DetachedProcessExecution;
  try {
    task = await runner.startShellExecution({
      argv,
      description: "dreaming",
      cwd,
      env,
      type: "dream",
      settings,
    });
  } catch (err) {
    unregister();
    rollbackConsolidationLock(memoryDir, priorMtime);
    throw err;
  }

  task.metadata = {
    ...task.metadata,
    phase: "starting",
    sessions_reviewing: String(sessionIds.length),
    prior_mtime: String(priorMtime),
    memory_dir: memoryDir,
    force: String(options.force ?? false),
    preview: String(options.preview ?? false),
    backup_dir: backupDir ?? "",
  };

  return task;
}

/** 廉价门槛检查后后台起 dream（10 分钟内同目录只扫一次会话）。 */
export async function executeAutoDream(options: StartDreamOptions): Promise<DetachedProcessExecution | null> {
  if (process.env[CHILD_ENV]) return null;
  const memCfg = options.settings.memory;
  if (!memCfg?.enabled || !memCfg.autoDreamEnabled) return null;

  const memoryDir = resolve(options.memoryDir);
  const lastAt = readLastConsolidatedAt(memoryDir);
  if ((Date.now() / 1000 - lastAt) / 3600 < (memCfg.autoDreamMinHours ?? DEFAULT_MIN_HOURS)) return null;

  const now = Date.now() / 1000;
  if (now - (lastSessionScanAt.get(memoryDir) ?? 0) < SESSION_SCAN_INTERVAL_SECONDS) return null;
  lastSessionScanAt.set(memoryDir, now);

  const sessionIds = [...new Set(options.recentSessionIds ?? [])];
  if (sessionIds.length < (memCfg.autoDreamMinSessions ?? DEFAULT_MIN_SESSIONS)) return null;

  return startDreamNow({ ...options, force: false });
}

/** 测试隔离：清空会话扫描节流表。 */
export function _resetAutodreamStateForTests(): void {
  lastSessionScanAt.clear();
}
