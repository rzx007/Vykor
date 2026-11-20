import { setTimeout as delay } from "node:timers/promises";
import {
  clearMatchingDaemonRegistry, getDaemonRegistryPath, readDaemonRegistry,
  sameDaemonRegistration, type DaemonRegistry,
} from "../daemon/paths.js";
import { acquireRegistryLease, daemonControlBusy } from "./registry-lease.js";

/** 进程存活判断：能发信号或 EPERM 都算存活（EPERM 表示进程存在但无权发信号）。 */
export function daemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function terminateDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function forceKillDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && daemonPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !daemonPidAlive(pid);
}

/** SIGTERM → 等待 graceMs → 强制结束 → 等待 forceKillMs；仍存活则抛错。 */
export async function stopDaemonProcess(
  pid: number,
  options: { graceMs?: number; forceKillMs?: number } = {},
): Promise<void> {
  if (!daemonPidAlive(pid)) return;
  terminateDaemonProcess(pid);
  if (await waitForProcessExit(pid, options.graceMs ?? 5_000)) return;
  forceKillDaemonProcess(pid);
  if (await waitForProcessExit(pid, options.forceKillMs ?? 2_000)) return;
  throw new Error(`Daemon process did not stop: ${pid}`);
}

/** Stop a CLI-managed registration only after its endpoint proves the recorded identity. */
export async function stopRegisteredDaemon(
  verify: (registry: DaemonRegistry) => Promise<boolean>,
  file = getDaemonRegistryPath(),
): Promise<DaemonRegistry | undefined> {
  let registry = readDaemonRegistry(file);
  if (!registry) {
    // A detached worker can own the registry while its listener is opening.
    // In that interval report busy instead of falsely reporting it stopped.
    let release: () => Promise<void>;
    try {
      release = await acquireRegistryLease(file, "owner", () => {});
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOCKED") throw daemonControlBusy();
      if (code === "ENOENT") return;
      throw error;
    }
    try {
      registry = readDaemonRegistry(file);
    } finally {
      await release();
    }
    if (!registry) return;
  }
  const expected = registry;
  const matches = () => sameDaemonRegistration(readDaemonRegistry(file), expected);
  if (!matches()) throw new Error("Daemon registration changed before stopping the process.");
  if (registry.pid === process.pid) throw new Error("Refusing to stop the calling process.");
  if (daemonPidAlive(registry.pid)) {
    const verified = await verify(registry);
    if (!matches()) throw new Error("Daemon registration changed while verifying the process.");
    if (daemonPidAlive(registry.pid)) {
      if (!verified) throw new Error(`Cannot verify daemon process ${registry.pid}. Stop it through the operating system.`);
      // Do not escalate after the wait, when the OS may have recycled this PID.
      if (!terminateDaemonProcess(registry.pid) && daemonPidAlive(registry.pid))
        throw new Error(`Cannot stop daemon process ${registry.pid}.`);
      if (!await waitForProcessExit(registry.pid))
        throw new Error(`Daemon process did not stop: ${registry.pid}`);
    }
  }

  // Windows can end the process before its JS cleanup runs. The owner lease
  // may remain until it expires. A replacement holding it must keep its file.
  const deadline = Date.now() + 12_000;
  while (matches()) {
    let release: () => Promise<void>;
    try {
      release = await acquireRegistryLease(file, "owner", () => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      await delay(100);
      continue;
    }
    try {
      clearMatchingDaemonRegistry(registry, file);
    } finally {
      await release();
    }
    break;
  }
  return registry;
}
