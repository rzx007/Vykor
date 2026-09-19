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
