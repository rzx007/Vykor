import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceCleanupService } from "../cleanup-settings.js";
import { SessionStore } from "@vykor/services";
import type { ToolOperationIntent } from "@vykor/agent-contracts";

describe("maintenance cleanup protection", () => {
  it("protects pending permissions and rechecks activity after preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-cleanup-")); const previous = process.env.VYKOR_DATA_DIR; process.env.VYKOR_DATA_DIR = root;
    let active = false; let pending = true;
    const remove = vi.fn(async () => ["s"]);
    const store = { sessions: { list: () => [{ id: "s", title: "old", updatedAt: 1 }], get: () => ({ id: "s", updatedAt: 1 }), listChildren: () => [] }, conversations: { listSessionInputAttachments: () => [] }, runs: { listRuns: () => [] }, toolOperations: { list: () => [] }, listSessionTasks: () => [], permissions: { list: () => pending ? [{ sessionId: "s", status: "pending" }] : [] }, listProjectionSettlements: () => [] };
    const service = new MaintenanceCleanupService(store as never, { hasAnyActiveRuns: () => active, runtimeSnapshot: () => ({ coordinator: { queuedRunCount: 0 } }) } as never, { deleteSessionTree: remove } as never);
    try {
      expect(service.preview({ kind: "session", olderThan: Date.now() }).protected[0]!.reason).toContain("待批准");
      pending = false; const preview = service.preview({ kind: "session", olderThan: Date.now() }); expect(preview.candidates).toHaveLength(1);
      active = true; const result = await service.execute({ previewId: preview.id, ids: ["s"] }); expect(result.skipped).toHaveLength(1); expect(remove).not.toHaveBeenCalled();
      active = false; const again = service.preview({ kind: "session", olderThan: Date.now() }); const done = await service.execute({ previewId: again.id, ids: ["s"] }); expect(done.completed).toEqual(["s"]); expect(service.audits()).toHaveLength(2);
    } finally { if (previous === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["prepared", "authorized", "dispatching", "unknown"] as const)("protects the entire aged tree when a grandchild has a %s operation", async state => {
    await withRealStore(async ({ store, service, addOperation, advanceTime }) => {
      const operationId = addOperation("grandchild", state);
      advanceTime();
      const preview = service.preview({ kind: "session", olderThan: Date.now() });
      expect(preview.candidates).toEqual([]);
      expect(preview.protected).toEqual([{ id: "root", reason: expect.stringContaining("工具操作") }]);
      await expect(service.execute({ previewId: preview.id, ids: ["root"] })).rejects.toThrow("清理对象不在预览中");
      expect(store.toolOperations.get(operationId)?.state).toBe(state);
      expect(store.sessions.get("root")).toBeDefined();
      expect(store.sessions.get("sibling")).toBeDefined();
    });
  });
  it("rechecks descendant operations before executing an earlier cleanup preview", async () => {
    await withRealStore(async ({ store, service, addOperation, advanceTime }) => {
      advanceTime();
      const preview = service.preview({ kind: "session", olderThan: Date.now() });
      expect(preview.candidates.map(row => row.id)).toEqual(["root"]);
      const operationId = addOperation("sibling", "unknown");
      const result = await service.execute({ previewId: preview.id, ids: ["root"] });
      expect(result.completed).toEqual([]);
      expect(result.skipped).toEqual([{ id: "root", reason: expect.stringContaining("工具操作") }]);
      expect(store.toolOperations.get(operationId)?.state).toBe("unknown");
      expect(store.sessions.get("grandchild")).toBeDefined();
    });
  });
  it("allows aged trees with confirmed operations and terminal Runs to be cleaned", async () => {
    await withRealStore(async ({ store, service, addOperation, advanceTime }) => {
      const operationId = addOperation("grandchild", "confirmed");
      advanceTime();
      const preview = service.preview({ kind: "session", olderThan: Date.now() });
      expect(preview.protected).toEqual([]);
      expect(preview.candidates.map(row => row.id)).toEqual(["root"]);
      expect((await service.execute({ previewId: preview.id, ids: ["root"] })).completed).toEqual(["root"]);
      expect(store.sessions.get("root")).toBeUndefined();
      expect(store.sessions.get("sibling")).toBeUndefined();
      expect(store.toolOperations.get(operationId)).toBeUndefined();
    });
  });
});

async function withRealStore(work: (fixture: {
  store: SessionStore;
  service: MaintenanceCleanupService;
  advanceTime(): void;
  addOperation(sessionId: string, state: "prepared" | "authorized" | "dispatching" | "unknown" | "confirmed"): string;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "maintenance-tool-operations-"));
  const previous = process.env.VYKOR_DATA_DIR; process.env.VYKOR_DATA_DIR = root;
  const time = vi.spyOn(Date, "now").mockReturnValue(1000);
  const store = new SessionStore({ path: join(root, "sessions.db") });
  const closeStore = store.close.bind(store);
  try {
    store.sessions.create({ id: "root", cwd: root, model: "m" });
    store.sessions.create({ id: "child", parentId: "root", cwd: root, model: "m" });
    store.sessions.create({ id: "grandchild", parentId: "child", cwd: root, model: "m" });
    store.sessions.create({ id: "sibling", parentId: "root", cwd: root, model: "m" });
    const service = new MaintenanceCleanupService(store, {
      hasAnyActiveRuns: () => false,
      runtimeSnapshot: () => ({ coordinator: { queuedRunCount: 0 } }),
    } as never, { deleteSessionTree: async (id: string) => store.conversationTransactions.deleteSessionTree(id) } as never);
    await work({ store, service, advanceTime: () => { time.mockReturnValue(2000); }, addOperation(sessionId, state) {
      const run = store.runs.createRun({ sessionId });
      const intent: ToolOperationIntent = {
        scope: { sessionId, runId: run.id, inputId: "i", agentId: "a", traceId: "t", cwd: root, signal: new AbortController().signal },
        toolUse: { type: "tool_use", id: "call", name: "write", input: {} },
      };
      const operation = store.toolOperations.prepare({ ...intent, toolIdentity: "cleanup-fixture@1" });
      if (state !== "prepared") {
        const authorized = store.toolOperations.authorize({ intent, operation, policyVersion: "p1" });
        if (state !== "authorized") {
          const receipt = store.toolOperations.dispatch({ intent, operation: authorized, policyVersion: "p1", ownerId: "owner" });
          if (state === "unknown" || state === "confirmed") store.toolOperations.settle({ receipt, result: {
            toolUseId: "call", toolName: "write", content: [{ type: "text", text: "receipt" }], executionState: state === "unknown" ? "unknown" : "completed",
          } });
        }
      }
      store.runs.updateRun(run.id, { status: "completed" });
      return operation.operationId;
    } });
  } finally {
    closeStore(); time.mockRestore();
    if (previous === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
