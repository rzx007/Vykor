import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { describe, expect, it, vi } from "vitest";
import { DaemonApplication } from "../daemon-application.js";
describe("read-only application readiness", () => {
  it("reads startup, ready and closed facts without starting work and returns detached values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maintenance-ready-"));
    const previousConfig = process.env.VYKOR_CONFIG_DIR; const previousData = process.env.VYKOR_DATA_DIR;
    process.env.VYKOR_CONFIG_DIR = join(directory, "config"); process.env.VYKOR_DATA_DIR = join(directory, "data");
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const log = vi.fn(); const application = new DaemonApplication({ store, log, ownerHeartbeatMs: 25 });
    try {
      expect(application.diagnosticState).toEqual({ phase: "starting", accepting: false });
      await application.ready();
      expect(application.diagnosticState).toEqual({ phase: "ready", accepting: true });
      const snapshot = application.diagnosticState; snapshot.accepting = false;
      expect(application.diagnosticState.accepting).toBe(true);
      expect(application.control.runtimeSnapshot().runs.total).toBe(0);
      vi.spyOn(store, "heartbeatApplicationOwner").mockImplementation(() => { throw new Error("owner lost") });
      await vi.waitFor(() => expect(application.diagnosticState).toEqual({ phase: "failed", accepting: false }));
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "application.owner_lost" }));
      await application.close();
      expect(application.diagnosticState).toEqual({ phase: "closed", accepting: false });
    } finally { await application.close(); store.close(); if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR; else process.env.VYKOR_CONFIG_DIR = previousConfig; if (previousData === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previousData; rmSync(directory, { recursive: true, force: true }); }
  });
});
