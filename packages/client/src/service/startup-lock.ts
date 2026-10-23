import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lock } from "proper-lockfile";

/** A registry-scoped filesystem lease also coordinates distinct SDK copies/processes. */
export async function acquireStartupLock(file: string, end: number, signal?: AbortSignal): Promise<{
  signal: AbortSignal;
  release: () => Promise<void>;
}> {
  await mkdir(dirname(file), { recursive: true });
  const compromised = new AbortController();
  while (Date.now() < end) {
    signal?.throwIfAborted();
    try {
      const release = await lock(file, {
        realpath: false, lockfilePath: `${file}.sdk-start.lock`,
        stale: 10_000, update: 5_000, retries: 0,
        onCompromised: error => compromised.abort(error),
      });
      return {
        signal: signal ? AbortSignal.any([signal, compromised.signal]) : compromised.signal,
        release,
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "ELOCKED") throw error;
      await sleep(Math.max(1, Math.min(50, end - Date.now())), undefined, { signal });
    }
  }
  throw new Error("Vykor service startup timed out waiting for the registry lock.");
}
