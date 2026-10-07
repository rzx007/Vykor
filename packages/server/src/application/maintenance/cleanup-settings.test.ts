import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceCleanupService } from "./cleanup-settings.js";

describe("maintenance cleanup protection", () => {
  it("protects pending permissions and rechecks activity after preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-cleanup-")); const previous = process.env.VYKOR_DATA_DIR; process.env.VYKOR_DATA_DIR = root;
    let active = false; let pending = true;
    const remove = vi.fn(async () => ["s"]);
    const store = { sessions: { list: () => [{ id: "s", title: "old", updatedAt: 1 }], get: () => ({ id: "s", updatedAt: 1 }), listChildren: () => [] }, conversations: { listSessionInputAttachments: () => [] }, runs: { listRuns: () => [] }, listSessionTasks: () => [], permissions: { list: () => pending ? [{ sessionId: "s", status: "pending" }] : [] }, listProjectionSettlements: () => [] };
    const service = new MaintenanceCleanupService(store as never, { hasAnyActiveRuns: () => active, runtimeSnapshot: () => ({ coordinator: { queuedRunCount: 0 } }) } as never, { deleteSessionTree: remove } as never);
    try {
      expect(service.preview({ kind: "session", olderThan: Date.now() }).protected[0]!.reason).toContain("待批准");
      pending = false; const preview = service.preview({ kind: "session", olderThan: Date.now() }); expect(preview.candidates).toHaveLength(1);
      active = true; const result = await service.execute({ previewId: preview.id, ids: ["s"] }); expect(result.skipped).toHaveLength(1); expect(remove).not.toHaveBeenCalled();
      active = false; const again = service.preview({ kind: "session", olderThan: Date.now() }); const done = await service.execute({ previewId: again.id, ids: ["s"] }); expect(done.completed).toEqual(["s"]); expect(service.audits()).toHaveLength(2);
    } finally { if (previous === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
  });
});
