import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskExecutor } from "./scheduled-task-executor.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("ScheduledTaskExecutor", () => {
  it("allocates a standalone workspace without a project and executes through Session admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "ohs-scheduled-executor-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const createSession = vi.fn((input) => ({ id: "s1", status: "idle", ...input }));
    const admitPrompt = vi.fn(async () => ({ run: { id: "r1" } }));
    const executor = new ScheduledTaskExecutor({
      outsideProjectWorkspaceRoot: root,
      settings: { model: "test" } as any,
      sessions: {
        getSession: vi.fn(), createSession,
        admitPrompt, awaitRun: vi.fn(async () => ({ status: "completed", output: "done" })),
      } as any,
    });
    const task = {
      id: "task-1", name: "Daily", prompt: "work", projectPaths: [], destination: "standalone",
      executionMode: "direct", model: "test", effort: "medium", skillNames: [], pluginNames: [],
      permissionProfile: { mode: "workspace_write", network: false },
    } as any;
    const result = await executor.execute(task, { id: "scheduled-1", scheduledFor: Date.now() } as any);
    expect(result).toEqual({ sessionId: "s1", runId: "r1", summary: "done" });
    expect(existsSync(createSession.mock.calls[0]![0].cwd)).toBe(true);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });
});
