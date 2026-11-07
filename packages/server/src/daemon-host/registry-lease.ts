import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { getDaemonRegistryPath } from "../daemon/paths.js";
import { ApplicationError } from "../shared/application-error.js";

export async function acquireRegistryLease(
  registryPath: string,
  kind: "owner" | "control",
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  const file = resolve(registryPath);
  // The SDK shares the controller target. The library also keys leases by target within one process.
  const target = kind === "owner" ? `${file}.owner` : file;
  return lock(target, {
    realpath: false,
    lockfilePath: kind === "owner" ? `${file}.owner.lock` : `${file}.sdk-start.lock`,
    stale: 10_000,
    update: 5_000,
    retries: 0,
    onCompromised,
  });
}

export async function withDaemonControlLock<T>(
  action: (signal: AbortSignal) => T | Promise<T>,
  registryPath = getDaemonRegistryPath(),
): Promise<T> {
  await mkdir(dirname(resolve(registryPath)), { recursive: true });
  const compromised = new AbortController();
  let release: () => Promise<void>;
  try {
    release = await acquireRegistryLease(registryPath, "control", (error) => compromised.abort(error));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw daemonControlBusy();
    throw error;
  }
  try {
    const result = await action(compromised.signal);
    compromised.signal.throwIfAborted();
    return result;
  } finally {
    if (!compromised.signal.aborted) await release();
  }
}

export function daemonControlBusy(): ApplicationError {
  return new ApplicationError(409, "后台启动状态正在变更，请稍后重试。");
}
