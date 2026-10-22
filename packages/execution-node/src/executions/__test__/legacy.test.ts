import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LspClient,
} from "../../lsp/index.js";
import {
  DetachedProcessSupervisor,
} from "@vykor/execution-node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testSettings = {
  model: "m",
  apiFormat: "openai" as const,
  maxTurns: 1,
  permission: { mode: "default" as const },
  sandbox: { enabled: false },
};

const taskManagers: DetachedProcessSupervisor[] = [];

function createTestDetachedProcessSupervisor(): DetachedProcessSupervisor {
  const manager = new DetachedProcessSupervisor(mkdtempSync(join(tmpdir(), "oh-services-task-")));
  taskManagers.push(manager);
  return manager;
}

afterEach(() => {
  vi.useRealTimers();
  while (taskManagers.length > 0) taskManagers.pop()!.close();
});

describe("LspClient", () => {
  it("surfaces strict sandbox unavailability instead of reporting no matches", async () => {
    const client = new LspClient({
      command: "",
      args: [],
      sessionId: "missing-lsp",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
    });
    await expect(client.workspaceSymbolSearch(process.cwd(), "QueryEngine"))
      .rejects.toThrow();
  });

  it("connects and disconnects", async () => {
    const client = new LspClient({
      command: "typescript-language-server",
      args: ["--stdio"],
    });
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});

describe("DetachedProcessSupervisor", () => {
  it("creates a shell task and tracks it", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    const task = await mgr.startShellExecution({
      command: "echo hello",
      description: "test echo",
      cwd: process.cwd(),
      settings: testSettings,
    });
    expect(task.id).toMatch(/^task_\d+$/);
    expect(task.type).toBe("shell");
    expect(task.status).toBe("running");
    expect(mgr.getExecution(task.id)).toBe(task);
  });

  it("lists tasks", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    await mgr.startShellExecution({
      command: "echo 1",
      description: "t1",
      cwd: process.cwd(),
      settings: testSettings,
    });
    await mgr.startAgentProcess("do stuff", "t2", process.cwd());
    const tasks = mgr.listExecutions();
    expect(tasks).toHaveLength(2);
  });

  it("filters tasks by status", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    // Agent task without argv/command is marked failed (needs-argv), not silently pending.
    await mgr.startAgentProcess("no-argv task", "desc", process.cwd());
    const failed = mgr.listExecutions("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.type).toBe("agent");
  });

  it("creates an agent task without argv as failed needs-argv (no silent pending)", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    const task = await mgr.startAgentProcess("write tests", "agent task", process.cwd(), "gpt-4");
    expect(task.type).toBe("agent");
    expect(task.status).toBe("failed");
    expect(task.metadata.needs_argv).toBe("1");
    expect(task.prompt).toBe("write tests");
  });

  it("readOutput throws for unknown task", () => {
    const mgr = createTestDetachedProcessSupervisor();
    expect(() => mgr.readOutput("nope")).toThrow("not found");
  });

  it("stopExecution throws for unknown task", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    await expect(mgr.stopExecution("nope")).rejects.toThrow("not found");
  });

  it("writeInput throws for unknown task", async () => {
    const mgr = createTestDetachedProcessSupervisor();
    await expect(mgr.writeInput("nope", "msg")).rejects.toThrow("not found");
  });

  it("shell task completes and produces output", async () => {
    const tasksDir = mkdtempSync(join(tmpdir(), "oh-services-task-"));
    const mgr = new DetachedProcessSupervisor(tasksDir);
    try {
      const task = await mgr.startShellExecution({
        command: "echo done",
        description: "test",
        cwd: process.cwd(),
        settings: testSettings,
      });
      const result = await mgr.awaitExecution(task.id, { timeoutMs: 5_000 });
      expect(result.output).toContain("done");
      expect(result.status).toBe("completed");
    } finally {
      mgr.close();
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });
});
