import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { daemonPidAlive, stopDaemonProcess, stopRegisteredDaemon } from "../lifecycle.js";
import { acquireRegistryLease } from "../registry-lease.js";
import { createDaemonRegistryEntry, readDaemonRegistry, writeDaemonRegistry } from "../../daemon/paths.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function withRegistry(
  test: (file: string, registry: ReturnType<typeof createDaemonRegistryEntry>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "vykor-daemon-stop-"));
  const file = join(directory, "registry.json");
  const registry = createDaemonRegistryEntry({
    url: "http://127.0.0.1:1234", token: "registered-token", pid: 42,
    version: "1", storePath: join(directory, "sessions.db"), launcher: "cli",
    executionSurface: "desktop_managed",
  });
  try {
    writeDaemonRegistry(registry, file);
    await test(file, registry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("daemon lifecycle", () => {
  it("treats EPERM as a live process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(daemonPidAlive(42)).toBe(true);
  });

  it("returns false when the process is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no such process");
    });
    expect(daemonPidAlive(42)).toBe(false);
  });

  it("throws when the process survives SIGTERM and force kill", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    await expect(
      stopDaemonProcess(42, { graceMs: 20, forceKillMs: 20 }),
    ).rejects.toThrow(/did not stop/i);
  });

  it("refuses to signal a live PID whose daemon endpoint cannot be verified", async () => {
    await withRegistry(async (file, registry) => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      await expect(stopRegisteredDaemon(async () => false, file)).rejects.toThrow(/verify/i);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      expect(readDaemonRegistry(file)).toEqual(registry);
    });
  });

  it("clears the exact registration after a verified process exits without a cleanup callback", async () => {
    await withRegistry(async (file, registry) => {
      let live = true;
      const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === "SIGTERM") live = false;
        else if (!live) throw new Error("no such process");
        return true;
      });
      await stopRegisteredDaemon(async () => true, file);
      expect(kill).toHaveBeenCalledWith(registry.pid, "SIGTERM");
      expect(readDaemonRegistry(file)).toBeUndefined();
    });
  });

  it("does not signal or delete a replacement published while verifying the old daemon", async () => {
    await withRegistry(async (file, registry) => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const replacement = { ...registry, token: "replacement", pid: 43 };
      await expect(stopRegisteredDaemon(async () => {
        writeDaemonRegistry(replacement, file);
        return true;
      }, file)).rejects.toThrow(/changed/i);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      expect(readDaemonRegistry(file)).toEqual(replacement);
    });
  });

  it("waits for the owner lease before clearing a dead registration", async () => {
    await withRegistry(async (file, registry) => {
      vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("no such process"); });
      const release = await acquireRegistryLease(file, "owner", () => {});
      const stopping = stopRegisteredDaemon(async () => false, file);
      const replacement = { ...registry, pid: 43, token: "replacement" };
      try {
        await delay(120);
        expect(readDaemonRegistry(file)).toEqual(registry);
        writeDaemonRegistry(replacement, file);
      } finally {
        await release();
        await stopping;
      }
      expect(readDaemonRegistry(file)).toEqual(replacement);
    });
  });

  it("reports an opening worker that owns the lock but has not published", async () => {
    await withRegistry(async (file) => {
      await rm(file);
      const release = await acquireRegistryLease(file, "owner", () => {});
      try {
        await expect(stopRegisteredDaemon(async () => false, file)).rejects.toMatchObject({ status: 409 });
      } finally {
        await release();
      }
      await expect(stopRegisteredDaemon(async () => false, file)).resolves.toBeUndefined();
    });
  });
});
