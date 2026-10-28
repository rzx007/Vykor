import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceCleanupService } from "../cleanup-settings.js";
import { SessionStore } from "@vykor/services";

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
  it("deletes completed result bodies with an inactive session, but protects an active Run", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-results-"));
    const store = new SessionStore({ path: join(root, "state.db") });
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      store.sessions.create({ id: "s", cwd: root, model: "m" });
      store.runs.createRun({ id: "r", sessionId: "s" });
      store.toolResults.save({ sessionId: "s", runId: "r", toolUseId: "call", toolName: "Write", sourceKind: "builtin", sourceId: null, text: "done", totalChars: 4 });
      time.mockReturnValue(2000);
      const service = new MaintenanceCleanupService(store, { hasAnyActiveRuns: () => false, runtimeSnapshot: () => ({ coordinator: { queuedRunCount: 0 } }) } as never, { deleteSessionTree: async id => store.conversationTransactions.deleteSessionTree(id) } as never);
      expect(service.preview({ kind: "session", olderThan: Date.now() - 1 }).protected).toHaveLength(1);
      store.runs.updateRun("r", { status: "completed" });
      time.mockReturnValue(3000);
      const preview = service.preview({ kind: "session", olderThan: Date.now() - 1 });
      expect((await service.execute({ previewId: preview.id, ids: ["s"] })).completed).toEqual(["s"]);
      expect(store.toolResults.list("s")).toEqual([]);
    } finally { time.mockRestore(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
