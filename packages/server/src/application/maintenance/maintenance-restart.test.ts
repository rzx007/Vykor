import { describe, expect, it, vi } from "vitest";
import type { SessionStore } from "@vykor/services";
import type { DaemonControlService } from "../control/daemon-control-service.js";
import type { DaemonTerminalService } from "../../terminal/daemon-terminal-service.js";
import { DaemonOperationGate } from "../control/daemon-operation-gate.js";
import { createMaintenanceRoutes } from "../../http/routes/maintenance.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VykorHttpServer } from "../../http/server.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

function fixture(tasks: Array<{ status: string }> = [], terminals: Array<{ status: string }> = []) {
  const gate = new DaemonOperationGate();
  const store = { path: "D:/test/sessions.db", sessions: { list: () => [{ id: "session" }] }, runs: { listRuns: () => [] }, listSessionTasks: () => tasks } as unknown as SessionStore;
  const control = { acquireGlobalMutation: () => gate.tryEnterBarrier({ kind: "global" }, () => true) } as unknown as DaemonControlService;
  const closeApplication = vi.fn(() => gate.beginShutdown().then(() => { gate.markClosed() }));
  const app = createMaintenanceRoutes({ store, control, terminals: { list: async () => terminals } as unknown as DaemonTerminalService, closeApplication });
  return { app, gate, closeApplication };
}
describe("resident daemon safe restart preparation", () => {
  it("closes admission before releasing its barrier and replies only after draining", async () => {
    const { app, gate, closeApplication } = fixture();
    const response = await app.request("/maintenance/prepare-restart", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prepared: true });
    expect(closeApplication).toHaveBeenCalledOnce();
    expect(() => gate.enter({ sessionId: "late", cwd: "D:/project" })).toThrow(/closing/);
  });
  it.each(["tasks", "terminals"])("refuses shutdown while real %s are still running", async kind => {
    const { app, gate, closeApplication } = fixture(kind === "tasks" ? [{ status: "running" }] : [], kind === "terminals" ? [{ status: "running" }] : []);
    const response = await app.request("/maintenance/prepare-restart", { method: "POST" });
    expect(response.status).toBe(409);
    expect(closeApplication).not.toHaveBeenCalled();
    const work = gate.enter({ sessionId: "still-usable", cwd: "D:/project" }); work.release();
  });
  it("does not prepare while an in-flight task owns the existing operation lease", async () => {
    const { app, gate, closeApplication } = fixture();
    const work = gate.enter({ sessionId: "active", cwd: "D:/project" });
    const response = await app.request("/maintenance/prepare-restart", { method: "POST" });
    expect(response.status).toBe(409); expect(closeApplication).not.toHaveBeenCalled(); work.release();
  });
  it("keeps the HTTP host healthy with an explicit non-accepting prepared state after the store closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maintenance-restart-health-"));
    vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config")); vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"));
    const server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), logger: () => {} });
    try {
      await server.application.ready();
      const response = await server.app.request("/maintenance/prepare-restart", { method: "POST", headers: { "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) } });
      expect(response.status).toBe(200);
      const health = await server.app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, ready: false, accepting: false, restartPrepared: true, activeRunCount: 0, queuedRunCount: 0 });
      expect(server.application.diagnosticState).toMatchObject({ phase: "closed", accepting: false });
    } finally { await server.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
});
