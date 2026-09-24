import { describe, expect, it, vi } from "vitest";

import type { DaemonRegistry } from "@vykor/server";

import { probeDaemonRegistry } from "./daemon-lifecycle.js";

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://daemon.test",
    pid: 42,
    token: "token",
    storePath: "sessions.db",
    startedAt: 100,
    version: "0.1.0",
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeDaemonRegistry", () => {
  it("accepts a healthy daemon from the current build", async () => {
    const calls: RequestInit[] = [];
    const status = await probeDaemonRegistry(registry(), {
      pidAlive: () => true,
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return response({ ok: true, version: "0.1.0" });
      },
      expectedVersion: "0.1.0",
      minimumStartedAt: 100,
    });
    expect(status).toBe("ready");
    expect(calls[0]?.headers).toBeUndefined();
  });

  it("marks a daemon started before the current CLI build as stale", async () => {
    const status = await probeDaemonRegistry(registry({ startedAt: 99 }), {
      pidAlive: () => true,
      fetch: async () => response({ ok: true, version: "0.1.0" }),
      expectedVersion: "0.1.0",
      minimumStartedAt: 100,
    });
    expect(status).toBe("stale");
  });

  it("marks a daemon from another release as stale", async () => {
    const status = await probeDaemonRegistry(registry({ version: "0.0.9" }), {
      pidAlive: () => true,
      fetch: async () => response({ ok: true, version: "0.0.9" }),
      expectedVersion: "0.1.0",
    });
    expect(status).toBe("stale");
  });

  it("does not treat an unrelated reused pid as a stale Vykor daemon", async () => {
    const status = await probeDaemonRegistry(registry(), {
      pidAlive: () => true,
      fetch: async () => response({ error: "Unauthorized" }, 401),
    });
    expect(status).toBe("unreachable");
  });

  it("treats an EPERM pid as alive and still probes /health", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    const status = await probeDaemonRegistry(registry(), {
      fetch: async () => response({ ok: true, version: "0.1.0" }),
      expectedVersion: "0.1.0",
    });
    expect(status).toBe("ready");
    spy.mockRestore();
  });
});
