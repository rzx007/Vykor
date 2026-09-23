import { mkdir, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import type { Settings } from "../index";
import { getConfigDir, getConfigFilePath } from "./paths";
import { loadSettings, saveSettings } from "./settings";

/** Raised by a change function when the edit target no longer matches what the editor opened. */
export class SettingsConflictError extends Error {
  readonly code = "settings_conflict";

  constructor(readonly field: string) {
    super(`Settings field changed concurrently: ${field}`);
    this.name = "SettingsConflictError";
  }
}

/** Raised when the cross-process settings lock cannot be acquired before the deadline. */
export class SettingsLockTimeoutError extends Error {
  readonly code = "settings_lock_timeout";

  constructor(readonly lockPath: string) {
    super(`Timed out waiting for the settings lock at ${lockPath}`);
    this.name = "SettingsLockTimeoutError";
  }
}

export interface SettingsLockOptions {
  /** Lock file path. Defaults to `<global settings.json>.lock`. */
  lockPath?: string;
  /** Maximum time to wait for the lock before failing, in milliseconds. */
  timeoutMs?: number;
  /** Delay between lock acquisition attempts, in milliseconds. */
  pollIntervalMs?: number;
  /** Age after which an abandoned lock file is forcibly reclaimed, in milliseconds. */
  staleMs?: number;
  /** Injectable sleep, mainly for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, mainly for deterministic tests. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_STALE_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation` while holding the cross-process settings lock.
 *
 * The lock is a freshly created file (`wx` = fail if it already exists). A writer
 * polls for a bounded time; an abandoned lock (older than `staleMs`) is reclaimed
 * so a crashed writer cannot wedge every other process. The lock is always
 * released in `finally`, even when `operation` throws.
 */
export async function withSettingsFileLock<T>(
  operation: () => Promise<T>,
  options: SettingsLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? `${getConfigFilePath()}.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  await mkdir(getConfigDir(), { recursive: true });
  const deadline = now() + timeoutMs;

  let handle: FileHandle | undefined;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimIfStale(lockPath, staleMs, now)) continue;
      if (now() >= deadline) throw new SettingsLockTimeoutError(lockPath);
      await sleep(pollIntervalMs);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function reclaimIfStale(
  lockPath: string,
  staleMs: number,
  now: () => number,
): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch {
    // The lock disappeared; retry immediately.
    return true;
  }
  if (now() - mtimeMs <= staleMs) return false;
  try {
    await rm(lockPath, { force: true });
    return true;
  } catch {
    // Reclaim failed (for example the file is still undeletable on Windows).
    // Fall through to the bounded wait instead of spinning without a deadline.
    return false;
  }
}

/**
 * Atomically read, transform, and persist the global settings file.
 *
 * `change` runs inside the lock and receives the latest on-disk settings, so a
 * change function that throws (for example {@link SettingsConflictError}) leaves
 * the file untouched. Callers must keep unrelated fields intact by spreading
 * `current`.
 */
export async function updateSettings(
  change: (current: Settings) => Settings | Promise<Settings>,
  options?: SettingsLockOptions,
): Promise<Settings> {
  return withSettingsFileLock(async () => {
    const current = await loadSettings();
    const next = await change(current);
    await saveSettings(next);
    return next;
  }, options);
}
