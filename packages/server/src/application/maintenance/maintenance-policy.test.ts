import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMaintenanceRoutes } from "../../http/routes/maintenance.js";
describe("storage retention policy", () => {
  it("starts disabled, rejects stale edits, and never deletes protected work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maintenance-policy-")); const previous = process.env.VYKOR_DATA_DIR; process.env.VYKOR_DATA_DIR = directory;
    const remove = vi.fn(async () => ["old"]);
    const context = { store: { path: join(directory, "sessions.db"), sessions: { list: () => [{ id: "old", updatedAt: 1, title: "old" }], listChildren: () => [], get: () => ({ id: "old", updatedAt: 1 }) }, runs: { listRuns: () => [] }, permissions: { list: () => [] }, listSessionTasks: () => [], listProjectionSettlements: () => [], conversations: { listSessionInputAttachments: () => [] } }, control: { hasAnyActiveRuns: () => true, runtimeSnapshot: () => ({ coordinator: { queuedRunCount: 0 } }) }, commands: { deleteSessionTree: remove } };
    const routes = createMaintenanceRoutes(context as never);
    const post = (path: string, body: unknown) => routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect(await (await routes.request("/maintenance/cleanup/policy")).json()).toMatchObject({ enabled: false, days: 90 });
      expect(await (await post("/maintenance/cleanup/policy/run", {})).json()).toMatchObject({ skipped: true });
      expect(remove).not.toHaveBeenCalled();
      expect((await post("/maintenance/cleanup/policy", { enabled: true, days: 30, expected: { enabled: true, days: 90 } })).status).toBe(409);
      expect((await post("/maintenance/cleanup/policy", { enabled: true, days: 30, expected: { enabled: false, days: 90 } })).status).toBe(200);
      expect((await post("/maintenance/cleanup/policy/run", {})).status).toBe(200);
      expect(remove).not.toHaveBeenCalled();
      expect(await (await routes.request("/maintenance/cleanup/policy")).json()).toMatchObject({ enabled: true, days: 30 });
    } finally { if (previous === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previous; rmSync(directory, { recursive: true, force: true }); }
  });
});
