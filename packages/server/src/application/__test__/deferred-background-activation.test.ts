import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { createDefaultNodeApplication } from "../default-node-application.js";
import { StartupRecoveryService } from "../recovery/startup-recovery-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("keeps durable runs unrecovered during validation and activates recovery exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "vykor-validation-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", root); vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
  const store = new SessionStore({ path: join(root, "sessions.db") });
  store.sessions.create({ id: "s1", cwd: root, model: "test" });
  store.runs.createRun({ id: "r1", sessionId: "s1" });
  const recovery = vi.spyOn(StartupRecoveryService.prototype, "run");
  const app = createDefaultNodeApplication({ store, settings: { model: "test" } as Settings, deferBackgroundActivation: true, log: () => {} });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await app.ready();
  expect(store.runs.getRun("r1")?.status).toBe("pending");
  expect(recovery).not.toHaveBeenCalled();
  await Promise.all([app.activateBackgroundWork(), app.activateBackgroundWork()]);
  expect(store.runs.getRun("r1")?.status).toBe("interrupted");
  expect(recovery).toHaveBeenCalledTimes(1);
});

it("preserves existing attachment resource files when a deferred validation runtime closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "validation-resources-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", root); vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
  const store = new SessionStore({ path: join(root, "sessions.db") });
  const resources = join(root, "attachment-session-resources"); mkdirSync(resources); writeFileSync(join(resources, "existing"), "preserve");
  store.sessions.create({ id: "s", cwd: root, model: "test" }); store.runs.createRun({ id: "r", sessionId: "s" });
  const app = createDefaultNodeApplication({ store, settings: { model: "test" } as Settings, deferBackgroundActivation: true, log: () => {} });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await app.ready(); await app.close();
  expect(readFileSync(join(resources, "existing"), "utf8")).toBe("preserve");
  expect(store.runs.getRun("r")?.status).toBe("pending");
});
