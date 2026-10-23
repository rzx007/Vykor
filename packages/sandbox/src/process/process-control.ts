import { spawn, type ChildProcess } from "node:child_process";

export type ProcessSignal = NodeJS.Signals | number;

type ManagedProcessStop = (signal: ProcessSignal) => void | Promise<void>;

const managedStops = new WeakMap<ChildProcess, ManagedProcessStop>();

/** Register backend-specific stop behavior for a process handle. */
export function registerManagedProcess(child: ChildProcess, stop: ManagedProcessStop): void {
  managedStops.set(child, stop);
  const cleanup = () => managedStops.delete(child);
  child.once("close", cleanup);
  child.once("error", cleanup);
}

/**
 * Stop a process and everything it started.
 *
 * POSIX processes use their process group. Windows host processes use
 * a detached POSIX process group or Windows taskkill /T.
 */
export function signalProcessTree(
  child: ChildProcess,
  signal: ProcessSignal = "SIGTERM",
): boolean {
  const managedStop = managedStops.get(child);
  if (managedStop) {
    void Promise.resolve(managedStop(signal)).catch(() => {});
    return true;
  }

  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return false;

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          /* process already exited */
        }
      });
      killer.once("close", (code) => {
        if (code === 0) return;
        try {
          child.kill(signal);
        } catch {
          /* process already exited */
        }
      });
      return true;
    } catch {
      return child.kill(signal);
    }
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

/** Stop a whole process tree and wait until the stop request has been handled. */
export async function terminateProcessTree(
  child: ChildProcess,
  signal: ProcessSignal = "SIGTERM",
): Promise<boolean> {
  const managedStop = managedStops.get(child);
  if (managedStop) {
    await managedStop(signal);
    return true;
  }

  if (child.pid == null) return false;
  if (process.platform !== "win32") return signalProcessTree(child, signal);

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      resolve(stopped);
    };
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", (code) => {
        if (code === 0) {
          finish(true);
          return;
        }
        try {
          finish(child.kill(signal));
        } catch {
          finish(false);
        }
      });
      killer.once("error", () => {
        try {
          finish(child.kill(signal));
        } catch {
          finish(false);
        }
      });
    } catch {
      try {
        finish(child.kill(signal));
      } catch {
        finish(false);
      }
    }
  });
}

/** Connect an AbortSignal to the same whole-tree stop behavior. */
export function bindProcessAbortSignal(child: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return;
  const abort = () => signalProcessTree(child, "SIGTERM");
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => signal.removeEventListener("abort", abort);
  child.once("close", cleanup);
  child.once("error", cleanup);
}
