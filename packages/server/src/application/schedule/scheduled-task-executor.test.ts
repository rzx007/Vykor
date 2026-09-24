import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskExecutor } from "./scheduled-task-executor.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("ScheduledTaskExecutor", () => {
  it("reports the selected session before waiting for the Agent run", async () => {
    let releaseRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const sessionReady = vi.fn();
    const executor = new ScheduledTaskExecutor({
      settings: { model: "test" } as any,
      sessionQueries: { getSession: vi.fn() },
      sessionCommands: {
        createSession: vi.fn(() => ({ id: "scheduled-session" })),
      } as any,
      sessionInteractions: {
        admitPrompt: vi.fn(async () => ({ run: { id: "agent-run" } })),
      },
      runControl: {
        awaitRun: vi.fn(async () => {
          await runFinished;
          return { status: "completed", output: "done" };
        }),
      },
    });

    const execution = executor.execute(
      {
        id: "task-1",
        name: "Daily",
        prompt: "work",
        projectPaths: ["D:/repo"],
        destination: "standalone",
        executionMode: "direct",
        model: "test",
        skillNames: [],
        pluginNames: [],
        permissionProfile: { mode: "workspace_write" },
      } as any,
      { id: "scheduled-1", scheduledFor: 1 } as any,
      sessionReady,
    );

    await vi.waitFor(() =>
      expect(sessionReady).toHaveBeenCalledWith("scheduled-session"),
    );
    expect(
      await Promise.race([
        execution.then(() => "finished"),
        Promise.resolve("running"),
      ]),
    ).toBe("running");
    releaseRun();
    await execution;
  });

  it("allocates a standalone workspace without a project and executes through Session admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "vk-scheduled-executor-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const createSession = vi.fn((input) => ({ id: "s1", status: "idle", ...input }));
    const admitPrompt = vi.fn(async () => ({ run: { id: "r1" } }));
    const executor = new ScheduledTaskExecutor({
      outsideProjectWorkspaceRoot: root,
      settings: { model: "test" } as any,
      sessionQueries: { getSession: vi.fn() },
      sessionCommands: { createSession },
      sessionInteractions: { admitPrompt },
      runControl: { awaitRun: vi.fn(async () => ({ status: "completed", output: "done" })) },
    });
    const task = {
      id: "task-1", name: "Daily", prompt: "work", projectPaths: [], destination: "standalone",
      executionMode: "direct", model: "test", effort: "medium", skillNames: [], pluginNames: [],
      permissionProfile: { mode: "workspace_write", network: false },
    } as any;
    const result = await executor.execute(task, { id: "scheduled-1", scheduledFor: Date.now() } as any, vi.fn());
    expect(result).toEqual({ runId: "r1", summary: "done" });
    expect(existsSync(createSession.mock.calls[0]![0].cwd)).toBe(true);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });

  it("forwards a non-enum reasoning effort into the standalone runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "vk-scheduled-effort-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const createSession = vi.fn((input) => ({ id: "s1", status: "idle", ...input }));
    const executor = new ScheduledTaskExecutor({
      outsideProjectWorkspaceRoot: root,
      settings: { model: "test" } as any,
      sessionQueries: { getSession: vi.fn() },
      sessionCommands: { createSession },
      sessionInteractions: { admitPrompt: vi.fn(async () => ({ run: { id: "r1" } })) },
      runControl: { awaitRun: vi.fn(async () => ({ status: "completed", output: "done" })) },
    });
    await executor.execute({
      id: "task-1", name: "Daily", prompt: "work", projectPaths: [], destination: "standalone",
      executionMode: "direct", model: "test", effort: "xhigh", skillNames: [], pluginNames: [],
      permissionProfile: { mode: "workspace_write", network: false },
    } as any, { id: "scheduled-1", scheduledFor: Date.now() } as any, vi.fn());

    expect(createSession.mock.calls[0]![0].metadata.runtime.effort).toBe("xhigh");
  });

  it("cleans an allocated standalone workspace when worktree mode has no project", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-scheduled-cleanup-"));
    const workspace = join(directory, "allocated");
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executor = new ScheduledTaskExecutor({
      sessionQueries: {} as any,
      sessionCommands: {} as any,
      sessionInteractions: {} as any,
      runControl: {} as any,
      allocateWorkspace: async () => { mkdirSync(workspace); return workspace; },
    });
    await expect(executor.execute({
      id: "task-1", projectPaths: [], destination: "standalone", executionMode: "worktree",
      permissionProfile: { mode: "workspace_write" }, skillNames: [], pluginNames: [],
    } as any, { id: "run-1" } as any, vi.fn())).rejects.toThrow("project is unavailable");
    expect(existsSync(workspace)).toBe(false);
  });

  it.each([
    [false, false, 0],
    [true, false, 1],
    [true, true, 0],
  ] as const)("handles worktree created=%s changed=%s cleanup", async (created, changed, removes) => {
    const remove = vi.fn(async () => {});
    const manager = {
      isGitRepo: vi.fn(async () => true),
      create: vi.fn(async () => ({ slug: "scheduled/task", path: "D:/repo-wt", branch: "codex/task", created })),
      hasChanges: vi.fn(async () => changed), remove,
    };
    const executor = new ScheduledTaskExecutor({
      settings: { model: "test" } as any,
      createWorktreeManager: (() => manager) as any,
      sessionQueries: { getSession: vi.fn() },
      sessionCommands: { createSession: vi.fn(() => ({ id: "s1" })) } as any,
      sessionInteractions: { admitPrompt: vi.fn(async () => { throw new Error("execution failed"); }) },
      runControl: { awaitRun: vi.fn() },
    });
    await expect(executor.execute({
      id: "task-1", name: "Task", prompt: "work", projectPaths: ["D:/repo"], destination: "standalone",
      executionMode: "worktree", model: "test", skillNames: [], pluginNames: [],
      permissionProfile: { mode: "workspace_write" },
    } as any, { id: "run-1", scheduledFor: 1 } as any, vi.fn())).rejects.toThrow("execution failed");
    expect(remove).toHaveBeenCalledTimes(removes);
  });
});
