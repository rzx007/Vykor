import { readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface FileLock {
  waiters: Waiter[];
}

interface BarrierWaiter extends Waiter {
  exclusive: boolean;
}

interface MutationBarrier {
  readers: number;
  writer: boolean;
  waiters: BarrierWaiter[];
}

// Symbol.for keeps independently loaded copies in the same JS process on one queue.
const locks = processState("vykor.execution-node.file-mutation-locks.v1", () => new Map<string, FileLock>());
const barrier = processState<MutationBarrier>("vykor.execution-node.file-mutation-barrier.v1", () => ({
  readers: 0,
  writer: false,
  waiters: [],
}));

/** Runs one complete mutation while holding every key. Cancellation only affects admission. */
export async function withFileMutationLocks<T>(
  keys: readonly string[],
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const releases: Release[] = [];
  try {
    releases.push(await acquirePermit(false, signal));
    for (const key of [...new Set(keys)].sort()) {
      releases.push(await acquireFileLock(key, signal));
    }
    signal?.throwIfAborted();
    return await work();
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) releases[index]!();
  }
}

/** Serializes a backend whose target cannot be matched safely to a host file. */
export async function withUnidentifiedFileMutationLock<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquirePermit(true, signal);
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
  }
}

/** Resolves host aliases before locking, including a not-yet-created path suffix. */
export async function hostFileMutationKey(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let candidate = resolve(process.platform === "win32" ? supportedWindowsPath(path) : path);
  const suffix: string[] = [];
  while (true) {
    signal?.throwIfAborted();
    let ancestor: string;
    try {
      ancestor = await realpath(candidate);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isMissingPath(error)) throw error;
      // A dangling link is not an absent ordinary segment. Refuse it rather than
      // assign a key that would differ from its target when the target is created.
      try {
        await readlink(candidate);
        throw unsupportedPath("Dangling symbolic links cannot be assigned a stable host mutation key");
      } catch (linkError) {
        if (!isMissingPath(linkError) && errorCode(linkError) !== "EINVAL") throw linkError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate));
      candidate = parent;
      continue;
    }
    signal?.throwIfAborted();
    // Win32 realpath can report ENOENT, rather than ENOTDIR, for file/child.
    if (suffix.length > 0 && !(await stat(ancestor)).isDirectory()) {
      throw Object.assign(new Error(`A host mutation ancestor is not a directory: ${ancestor}`), { code: "ENOTDIR" });
    }
    signal?.throwIfAborted();
    const canonical = join(ancestor, ...suffix);
    // The host OS alone does not establish a volume's case/Unicode rules.
    // Conservatively merge spelling variants; case-sensitive filesystems may
    // serialize distinct names, while the original I/O paths stay unchanged.
    const identityPath = process.platform === "win32" ? supportedWindowsPath(canonical) : canonical;
    return `host:${identityPath.normalize("NFD").toLowerCase().toUpperCase().normalize("NFD")}`;
  }
}

function acquireFileLock(key: string, signal?: AbortSignal): Promise<Release> {
  signal?.throwIfAborted();
  const existing = locks.get(key);
  if (!existing) {
    const lock: FileLock = { waiters: [] };
    locks.set(key, lock);
    return Promise.resolve(fileRelease(key, lock));
  }
  return new Promise<Release>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal };
    waiter.onAbort = () => {
      const index = existing.waiters.indexOf(waiter);
      if (index < 0) return;
      existing.waiters.splice(index, 1);
      detachAbort(waiter);
      reject(signal!.reason);
    };
    existing.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

function fileRelease(key: string, lock: FileLock): Release {
  return once(() => {
    let waiter: Waiter | undefined;
    while ((waiter = lock.waiters.shift())) {
      detachAbort(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      waiter.resolve(fileRelease(key, lock));
      return;
    }
    if (locks.get(key) === lock) locks.delete(key);
  });
}

function acquirePermit(exclusive: boolean, signal?: AbortSignal): Promise<Release> {
  signal?.throwIfAborted();
  return new Promise<Release>((resolve, reject) => {
    const waiter: BarrierWaiter = { exclusive, resolve, reject, signal };
    waiter.onAbort = () => {
      const index = barrier.waiters.indexOf(waiter);
      if (index < 0) return;
      barrier.waiters.splice(index, 1);
      detachAbort(waiter);
      reject(signal!.reason);
      drainPermits();
    };
    barrier.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    drainPermits();
  });
}

function drainPermits(): void {
  if (barrier.writer) return;
  while (barrier.waiters.length > 0) {
    const next = barrier.waiters[0]!;
    if (next.exclusive && barrier.readers > 0) return;
    barrier.waiters.shift();
    detachAbort(next);
    if (next.signal?.aborted) {
      next.reject(next.signal.reason);
      continue;
    }
    if (next.exclusive) barrier.writer = true;
    else barrier.readers++;
    next.resolve(once(() => {
      if (next.exclusive) barrier.writer = false;
      else barrier.readers--;
      drainPermits();
    }));
    if (next.exclusive) return;
  }
}

function detachAbort(waiter: Waiter): void {
  if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
}

function once(release: Release): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function processState<T>(name: string, create: () => T): T {
  const state = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(name);
  return (state[key] ??= create()) as T;
}

function supportedWindowsPath(path: string): string {
  let normalized = path.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/i.test(normalized)) normalized = normalized.slice(4);
  else if (/^\\\\[?.]\\/.test(normalized)) throw unsupportedPath("Device paths cannot be assigned a host mutation key");
  const withoutDrive = normalized.replace(/^[a-z]:/i, "");
  for (const segment of withoutDrive.split("\\")) {
    if (!segment || segment === "." || segment === "..") continue;
    if (/[ .]$/.test(segment) || segment.includes(":")) {
      throw unsupportedPath("Trailing dots, spaces and alternate data streams are unsupported in host mutation keys");
    }
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw unsupportedPath("Reserved Windows device names cannot be assigned a host mutation key");
    }
  }
  return normalized;
}

function isMissingPath(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function unsupportedPath(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "ENOTSUP" });
}
