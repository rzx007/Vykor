import type { SessionExecutionRecord } from "@vykor/protocol";
import { mkdtempSync, rmSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { DetachedProcessSupervisor } from "@vykor/services/executions";
import { createDefaultToolRegistry } from "@vykor/tools";
import type { TerminalSessionInfo } from "@vykor/terminal";
import { describe, expect, it, vi } from "vitest";

import { DaemonJobService, readPersistedChildActivity } from "./daemon-job-service.js";
import { SessionExecutionProjector } from "../application/session/session-execution-projector.js";

const terminal: TerminalSessionInfo = {
  id: "terminal-1",
  name: "dev server",
  projectId: "project-1",
  runtime: "local",
  source: "agent",
  sessionId: "session-1",
  status: "running",
  cwd: "/repo",
  shell: "/bin/sh",
  cols: 100,
  rows: 30,
  createdAt: "2026-08-17T00:00:00.000Z",
};

const task: SessionExecutionRecord = {
  id: "task-1",
  sessionId: "session-1",
  type: "agent",
  status: "running",
  description: "review",
  cwd: "/repo",
  metadata: {
    executionBackend: "child_agent",
    runtimeExecutionId: "manager-1",
  },
  createdAt: 10,
  startedAt: 11,
  updatedAt: 12,
};

describe("DaemonJobService", () => {
  it("reads a projected exit code after the store reopens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-job-exit-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({ path });
    let reopened: SessionStore | undefined;
    try {
      store.sessions.create({ id: "session-1", cwd: "/repo", model: "test" });
      store.createSessionTask({
        id: "task-1", sessionId: "session-1", type: "shell", description: "tests", cwd: "/repo",
        metadata: { executionBackend: "detached_process", owner: "kept" },
      });
      new SessionExecutionProjector({
        store, getChildAgentExecutionRegistry: () => { throw new Error("unused"); },
        events: { checkpoint: () => 0, publishSince: () => undefined },
        traceIdForRun: () => "", log: () => undefined,
      }).syncPersistentExecution({
        id: "task-1", type: "shell", status: "failed", description: "tests", cwd: "/repo",
        metadata: {}, processExitCode: 7,
      }, { readOutput: () => "all passed", registerExecutionListener: () => () => undefined });
      store.close();
      reopened = new SessionStore({ path });
      const service = new DaemonJobService(
        {
          getSession: (id: string) => reopened!.sessions.get(id),
          listSessionTasks: (id: string) => reopened!.listSessionTasks(id),
          getSessionTask: (id: string) => reopened!.getSessionTask(id),
        } as any, { list: async () => [] } as any,
        () => ({}) as any, () => ({}) as any,
        { list: () => [], load: () => undefined } as any,
      );
      const [job] = await service.list({ sessionId: "session-1", includeFinished: true });
      expect(job).toMatchObject({ status: "failed", exitCode: 7, metadata: { owner: "kept" } });
    } finally {
      reopened?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only known background log facts through durable JobRead JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-job-log-facts-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({ path });
    const supervisor = new DetachedProcessSupervisor(join(dir, "tasks"));
    let reopened: SessionStore | undefined;
    try {
      store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
      const projector = new SessionExecutionProjector({
        store, getChildAgentExecutionRegistry: () => { throw new Error("unused"); },
        events: { checkpoint: () => 0, publishSince: () => undefined }, traceIdForRun: () => "", log: () => undefined,
      });
      for (const id of ["task-1", "task-2"]) {
        store.createSessionTask({ id, sessionId: "session-1", type: "shell", description: "tests", cwd: dir,
          metadata: { executionBackend: "detached_process" } });
        projector.trackProcessExecution(supervisor, id);
      }
      await supervisor.startShellExecution({ id: "task-1", sessionId: "session-1", cwd: dir,
        description: "large output", argv: [process.execPath, "-e", "process.stdout.write('a'.repeat(10 * 1024 * 1024 + 31))"] });
      await supervisor.awaitExecution("task-1", { timeoutMs: 10_000 });
      const failing = await supervisor.startShellExecution({ id: "task-2", sessionId: "session-1", cwd: dir,
        description: "failed log write", argv: [process.execPath, "-e", "setTimeout(() => process.stdout.write('data'), 300)"] });
      renameSync(failing.outputFile!, `${failing.outputFile}.old`);
      mkdirSync(failing.outputFile!);
      await expect(supervisor.awaitExecution("task-2", { timeoutMs: 10_000 })).rejects.toThrow(/EISDIR|directory/i);
      for (let i = 0; i < 100 && (store.getSessionTask("task-1")?.status !== "completed" || store.getSessionTask("task-2")?.status !== "completed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(store.getSessionTask("task-1")?.status).toBe("completed");
      expect(store.getSessionTask("task-2")?.status).toBe("completed");
      store.close();
      reopened = new SessionStore({ path });
      const service = new DaemonJobService({
        getSession: (id: string) => reopened!.sessions.get(id),
        listSessionTasks: (id: string) => reopened!.listSessionTasks(id),
        getSessionTask: (id: string) => reopened!.getSessionTask(id),
      } as any, { list: async () => [] } as any, () => ({}) as any, () => ({}) as any,
      { list: () => [], load: () => undefined } as any);
      const read = await service.read({ sessionId: "session-1", jobId: "task-1" });
      const json = JSON.stringify(read);
      expect(json).toContain('"outputDiscardedBytes":"31"');
      expect(read.text).toContain("a".repeat(100));
      expect(read.text).not.toContain("已丢失");
      const tool = createDefaultToolRegistry({ jobs: true }).get("JobRead")!;
      const toolResult = await tool.execute({ jobId: "task-1" }, { cwd: dir, sessionId: "session-1", jobs: service });
      expect(JSON.parse((toolResult.content[0] as { text: string }).text)).toMatchObject({ snapshot: { metadata: {
        outputDiscardedBytes: "31",
      } } });
      const failureResult = await tool.execute({ jobId: "task-2" }, { cwd: dir, sessionId: "session-1", jobs: service });
      expect(JSON.parse((failureResult.content[0] as { text: string }).text)).toMatchObject({ snapshot: { status: "completed", metadata: { outputWriteFailed: "1" } } });
      const oldCursor = await service.read({ sessionId: "session-1", jobId: "task-1", after: read.cursor });
      expect(oldCursor).toMatchObject({ text: "", cursor: read.cursor, snapshot: { metadata: { outputDiscardedBytes: "31" } } });
    } finally {
      await supervisor.aclose();
      reopened?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads only a persisted detached-process exit result", async () => {
    const base = { ...task, type: "shell", status: "failed" as const };
    const jobs = [
      { ...base, id: "actual", metadata: { executionBackend: "detached_process", processExitCode: 7 } },
      { ...base, id: "legacy", metadata: { executionBackend: "detached_process" } },
      { ...base, id: "running", status: "running" as const, output: "全部通过", metadata: { executionBackend: "detached_process", processExitCode: 0 } },
      { ...base, id: "child", metadata: { executionBackend: "child_agent", processExitCode: 7 } },
    ];
    const { service } = createService(jobs);
    const snapshots = await service.list({ sessionId: "session-1", includeFinished: true });
    expect(snapshots.find((job) => job.id === "actual")?.exitCode).toBe(7);
    expect(snapshots.find((job) => job.id === "legacy")?.exitCode).toBeUndefined();
    expect(snapshots.find((job) => job.id === "running")).toMatchObject({ status: "running" });
    expect(snapshots.find((job) => job.id === "running")?.exitCode).toBeUndefined();
    expect(snapshots.find((job) => job.id === "child")?.exitCode).toBeUndefined();
  });

  it("gives terminal and detached-process Agent producers non-overlapping Job views", async () => {
    const shellTask: SessionExecutionRecord = {
      ...task,
      id: "shell-1",
      type: "shell",
      description: "dev server",
      metadata: {
        executionBackend: "detached_process",
        runtimeExecutionId: "process-1",
      },
    };
    const frameworkShellTask: SessionExecutionRecord = {
      ...shellTask,
      id: "framework-shell-1",
      metadata: {
        executionBackend: "child_agent",
        runtimeExecutionId: "child-agent-1",
      },
    };
    const workflow = {
      runId: "workflow-1",
      ownerSession: "session-1",
      status: "running",
      summary: "coordinate review",
      plan: { mode: "sequential", tasks: [] },
      runningTaskIds: [],
      pendingTaskIds: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const { service } = createService([task, shellTask, frameworkShellTask], {
      workflows: {
        list: () => [workflow],
        load: (runId: string) => runId === workflow.runId ? workflow : undefined,
      },
    });
    const owner = { id: "session-1" } as any;
    const terminalJobs = service.createTerminalAgentHost(owner);
    const shellJobs = service.createDetachedProcessAgentHost(owner);

    await expect(terminalJobs.list({
      sessionId: "session-1",
      includeFinished: true,
    })).resolves.toEqual([
      expect.objectContaining({ id: "terminal-1", kind: "terminal" }),
    ]);
    await expect(shellJobs.list({
      sessionId: "session-1",
      includeFinished: true,
    })).resolves.toEqual([
      expect.objectContaining({ id: "shell-1", kind: "shell" }),
    ]);
    await expect(terminalJobs.read({
      sessionId: "session-1",
      jobId: "shell-1",
    })).rejects.toThrow("Job not found: shell-1");
    await expect(shellJobs.read({
      sessionId: "session-1",
      jobId: "terminal-1",
    })).rejects.toThrow("Job not found: terminal-1");
    await expect(shellJobs.read({
      sessionId: "session-1",
      jobId: "task-1",
    })).rejects.toThrow("Job not found: task-1");
    await expect(shellJobs.read({
      sessionId: "session-1",
      jobId: "framework-shell-1",
    })).rejects.toThrow("Job not found: framework-shell-1");
    await expect(shellJobs.read({
      sessionId: "session-1",
      jobId: "workflow:workflow-1",
    })).rejects.toThrow("Job not found: workflow:workflow-1");
  });

  it("includes a detached process task even when its durable task type is not shell", async () => {
    const detachedTask: SessionExecutionRecord = {
      ...task,
      id: "detached-dream-1",
      type: "dream",
      metadata: {
        executionBackend: "detached_process",
        runtimeExecutionId: "process-2",
      },
    };
    const { service } = createService(detachedTask);

    await expect(service.createDetachedProcessAgentHost({ id: "session-1" } as any).list({
      sessionId: "session-1",
      includeFinished: true,
    })).resolves.toEqual([
      expect.objectContaining({ id: "detached-dream-1", kind: "dream" }),
    ]);
  });

  it("applies a scoped list limit after hiding jobs from other sources", async () => {
    const detachedTask: SessionExecutionRecord = {
      ...task,
      id: "older-detached-task",
      type: "shell",
      metadata: {
        executionBackend: "detached_process",
        runtimeExecutionId: "process-2",
      },
    };
    const { service } = createService(detachedTask);

    await expect(service.createDetachedProcessAgentHost({ id: "session-1" } as any).list({
      sessionId: "session-1",
      includeFinished: true,
      limit: 1,
    })).resolves.toEqual([
      expect.objectContaining({ id: "older-detached-task", kind: "shell" }),
    ]);
  });

  it("does not claim a metadata-less framework child as a detached process", async () => {
    const frameworkChild: SessionExecutionRecord = {
      ...task,
      id: "legacy-child-1",
      childSessionId: "child-session-1",
      metadata: {},
    };
    const { service } = createService(frameworkChild);
    const jobs = service.createDetachedProcessAgentHost({ id: "session-1" } as any);

    const listed = await jobs.list({
      sessionId: "session-1",
      includeFinished: true,
    });
    const readFailure = await jobs.read({
      sessionId: "session-1",
      jobId: "legacy-child-1",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect.soft(listed).toEqual([]);
    expect(readFailure).toMatchObject({
      message: "Job not found: legacy-child-1",
    });
  });

  it("projects owned terminals and durable tasks into one list", async () => {
    const { service } = createService();
    const jobs = await service.list({ sessionId: "session-1" });

    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "terminal-1", kind: "terminal", ownerSession: "session-1" }),
      expect.objectContaining({ id: "task-1", kind: "agent", ownerSession: "session-1" }),
    ]));
  });

  it("forwards terminal output cursors through the common read protocol", async () => {
    const { service, terminals } = createService();
    const result = await service.read({ sessionId: "session-1", jobId: "terminal-1", after: 4, maxChars: 20 });

    expect(terminals.readRequest).toHaveBeenCalledWith({ terminalId: "terminal-1", after: 4, maxChars: 20 });
    expect(result).toMatchObject({ text: "ready", cursor: 5, snapshot: { kind: "terminal" } });
  });

  it("uses the terminal provider settlement wait", async () => {
    const { service, terminals } = createService();
    terminals.wait.mockResolvedValue({
      terminalId: terminal.id,
      data: "done",
      sequence: 6,
      truncated: false,
      terminal: { ...terminal, status: "completed", exitedAt: "2026-08-17T00:00:01.000Z", exitCode: 0 },
      timedOut: false,
    });

    const result = await service.wait({ sessionId: "session-1", jobId: terminal.id, timeoutMs: 500, after: 5 });

    expect(terminals.wait).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: terminal.id,
      timeoutMs: 500,
      after: 5,
    }));
    expect(result).toMatchObject({ timedOut: false, text: "done", snapshot: { status: "completed", exitCode: 0 } });
  });

  it("attaches the child activity snapshot to a framework child JobRead", async () => {
    const childTask: SessionExecutionRecord = {
      ...task,
      id: "child-task-1",
      childSessionId: "child-session-1",
      runId: "run-1",
      metadata: { executionBackend: "child_agent", runtimeExecutionId: "child-agent-1" },
    };
    const activity = {
      version: 1 as const,
      runId: "run-1",
      updatedAt: 20,
      latestAssistantText: "working",
      toolCalls: 1,
      modelTurns: 1,
    };
    const readChildActivity = vi.fn(() => activity);
    const { service } = createService(childTask, { readChildActivity });

    const result = await service.read({ sessionId: "session-1", jobId: "child-task-1" });

    expect(readChildActivity).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      childSessionId: "child-session-1",
      runId: "run-1",
    });
    expect(result.details).toEqual({ activity });
    expect(result.snapshot).toMatchObject({
      id: "child-task-1",
      metadata: { childSessionId: "child-session-1" },
    });
  });

  it("returns a non-timeout wait when the child task cursor advances while still running", async () => {
    const childTask: SessionExecutionRecord = {
      ...task,
      id: "child-task-1",
      childSessionId: "child-session-1",
      runId: "run-1",
      metadata: { executionBackend: "child_agent", runtimeExecutionId: "child-agent-1" },
    };
    const advanced = { ...childTask, updatedAt: 13, metadata: { ...childTask.metadata } };
    const waitForSessionTaskChange = vi.fn(async () => advanced);
    const { service } = createService(childTask, { waitForSessionTaskChange });

    const result = await service.wait({ sessionId: "session-1", jobId: "child-task-1", timeoutMs: 50 });

    expect(waitForSessionTaskChange).toHaveBeenCalledWith(
      "child-task-1",
      12,
      expect.objectContaining({ timeoutMs: 50 }),
    );
    expect(result).toMatchObject({ timedOut: false, snapshot: { status: "running" } });
  });

  it("reports a timeout when the child task does not change before the deadline", async () => {
    const childTask: SessionExecutionRecord = {
      ...task,
      id: "child-task-1",
      childSessionId: "child-session-1",
      runId: "run-1",
      metadata: { executionBackend: "child_agent", runtimeExecutionId: "child-agent-1" },
    };
    const waitForSessionTaskChange = vi.fn(async () => ({ ...childTask }));
    const { service } = createService(childTask, { waitForSessionTaskChange });

    const result = await service.wait({ sessionId: "session-1", jobId: "child-task-1", timeoutMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.snapshot.status).toBe("running");
  });

  it("exposes a terminal child failure and partial result through JobRead", async () => {
    const partialResult = {
      version: 1,
      childSessionId: "child-session-1",
      runId: "run-1",
      source: "limit_finalization",
      text: "final report",
      truncated: false,
    };
    const childTask: SessionExecutionRecord = {
      ...task,
      id: "child-task-1",
      status: "failed",
      childSessionId: "child-session-1",
      runId: "run-1",
      metadata: {
        executionBackend: "child_agent",
        runtimeExecutionId: "child-agent-1",
        childFailure: { failureKind: "max_turns", partialResult },
      },
    };
    const { service } = createService(childTask);

    const result = await service.read({ sessionId: "session-1", jobId: "child-task-1" });

    expect(result.details).toMatchObject({
      childFailure: { failureKind: "max_turns", partialResult },
    });
    expect(result.snapshot.metadata).toMatchObject({ childFailure: { failureKind: "max_turns" } });
  });

  it("does not read child activity for detached process jobs", async () => {
    const detached: SessionExecutionRecord = {
      ...task,
      id: "detached-1",
      type: "shell",
      metadata: { executionBackend: "detached_process", runtimeExecutionId: "process-1" },
    };
    const readChildActivity = vi.fn();
    const { service } = createService(detached, { readChildActivity });

    const result = await service.read({ sessionId: "session-1", jobId: "detached-1" });

    expect(readChildActivity).not.toHaveBeenCalled();
    expect(result.details).toBeUndefined();
  });

  it("reads only committed child activity from the durable store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-child-activity-"));
    const path = join(dir, "store.db");
    let store = new SessionStore({ path });
    let reopened: SessionStore | undefined;
    try {
      store.sessions.create({ id: "parent", cwd: "/repo", model: "test" });
      store.sessions.create({
        id: "child",
        parentId: "parent",
        cwd: "/repo",
        model: "test",
        metadata: { childId: "c1" },
      });
      store.runs.createRun({ id: "run-1", sessionId: "child" });
      store.runs.createRun({ id: "run-other", sessionId: "parent" });
      const message = store.conversations.createMessage({
        sessionId: "child",
        role: "assistant",
        runId: "run-1",
      });
      store.conversations.upsertMessagePart({
        sessionId: "child",
        messageId: message.id,
        type: "reasoning",
        status: "completed",
        text: "SECRET REASONING",
      });
      store.conversations.upsertMessagePart({
        sessionId: "child",
        messageId: message.id,
        type: "text",
        status: "completed",
        text: "committed answer",
        metadata: { modelGeneration: { generationId: "g1", attempt: 1, committed: true } },
      });
      store.conversations.upsertMessagePart({
        sessionId: "child",
        messageId: message.id,
        type: "text",
        status: "completed",
        text: "superseded text",
        metadata: { modelGeneration: { generationId: "g2", attempt: 1, superseded: true } },
      });
      store.conversations.upsertMessagePart({
        sessionId: "child",
        messageId: message.id,
        type: "text",
        status: "running",
        text: "uncommitted text",
        metadata: { modelGeneration: { generationId: "g3", attempt: 1 } },
      });
      store.conversations.upsertMessagePart({
        sessionId: "child",
        messageId: message.id,
        type: "tool",
        status: "completed",
        toolUseId: "t1",
        toolName: "Read",
        input: { file_path: "/secret/path" },
        output: "SECRET BODY",
      });
      const attempt = store.runs.createRunAttempt({ runId: "run-1" });
      store.runs.updateRunAttempt(attempt.id, {
        status: "completed",
        inputTokens: 10,
        outputTokens: 5,
      });

      const activity = readPersistedChildActivity(durableReader(store), {
        parentSessionId: "parent",
        childSessionId: "child",
        runId: "run-1",
      });

      expect(activity).toMatchObject({
        version: 1,
        runId: "run-1",
        latestAssistantText: "committed answer",
        toolCalls: 1,
        modelTurns: 1,
        latestTool: { name: "Read", status: "completed" },
        usage: { inputTokens: 10, outputTokens: 5, incomplete: false },
      });
      const serialized = JSON.stringify(activity);
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("uncommitted");
      expect(serialized).not.toContain("/secret/path");

      expect(readPersistedChildActivity(durableReader(store), {
        parentSessionId: "other",
        childSessionId: "child",
        runId: "run-1",
      })).toBeUndefined();
      expect(readPersistedChildActivity(durableReader(store), {
        parentSessionId: "parent",
        childSessionId: "missing",
        runId: "run-1",
      })).toBeUndefined();
      expect(readPersistedChildActivity(durableReader(store), {
        parentSessionId: "parent",
        childSessionId: "child",
        runId: "run-other",
      })).toBeUndefined();

      store.close();
      reopened = new SessionStore({ path });
      await expect(Promise.resolve(readPersistedChildActivity(durableReader(reopened), {
        parentSessionId: "parent",
        childSessionId: "child",
        runId: "run-1",
      }))).resolves.toMatchObject({ latestAssistantText: "committed answer", runId: "run-1" });
      store = reopened;
    } finally {
      reopened?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let an Agent address another session through its host", async () => {
    const { service } = createService();
    const host = service.createTerminalAgentHost({ id: "session-1" } as any);
    await expect(host.list({ sessionId: "session-2" })).rejects.toThrow("owner session mismatch");
  });

  it.each([
    { type: "shell", status: "running" },
    { type: "agent", status: "stopped" },
    { type: "agent", status: "interrupted" },
  ] as const)("rejects input when a $status $type job does not advertise send", async (change) => {
    const projected = { ...task, ...change };
    const { service, manager } = createService(projected);

    await expect(service.send({
      sessionId: "session-1",
      jobId: projected.id,
      data: "continue",
    })).rejects.toThrow("does not accept input");
    expect(manager.writeInput).not.toHaveBeenCalled();
  });

  it.each(["pending", "running", "completed", "failed"] as const)(
    "sends input to a %s Agent job so its session can continue",
    async (status) => {
      const projected = { ...task, status };
      const { service, manager } = createService(projected);

      await service.send({
        sessionId: "session-1",
        jobId: projected.id,
        data: "continue",
      });

      expect(manager.writeInput).toHaveBeenCalledWith("manager-1", "continue");
      await expect(service.list({ sessionId: "session-1" })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: projected.id, capabilities: expect.objectContaining({ send: true }) }),
        ]),
      );
    },
  );

  it("cancels a reserved shell before a runtime process exists", async () => {
    const pending = {
      ...task,
      type: "shell",
      status: "pending" as const,
      metadata: { admissionPhase: "dispatching" },
    };
    const { service, store, manager } = createService(pending);

    await expect(service.cancel({
      sessionId: "session-1",
      jobId: pending.id,
      reason: "no longer needed",
    })).resolves.toMatchObject({
      id: pending.id,
      status: "killed",
      metadata: { admissionPhase: "cancelled_before_start" },
    });
    expect(manager.stopExecution).not.toHaveBeenCalled();
    expect(store.updateSessionTask).toHaveBeenCalledWith(pending.id, {
      status: "stopped",
      metadata: { admissionPhase: "cancelled_before_start" },
    });
  });

  it("lets an inherited root host operate on a descendant's own jobs", async () => {
    const childTask = {
      ...task,
      sessionId: "child-1",
      type: "shell" as const,
      metadata: {
        executionBackend: "detached_process",
        runtimeExecutionId: "child-process-1",
      },
    };
    const { service, store } = createService(childTask);
    store.getSession.mockImplementation((id: string) => {
      if (id === "session-1") return { id, cwd: "/repo" } as any;
      if (id === "child-1") return { id, parentId: "session-1", cwd: "/repo/worktree" } as any;
      return undefined;
    });
    const host = service.createDetachedProcessAgentHost({ id: "session-1" } as any);

    await expect(host.list({ sessionId: "child-1" })).resolves.toContainEqual(
      expect.objectContaining({ id: childTask.id, ownerSession: "child-1" }),
    );
  });

  it("cancels a Workflow by stopping child-agent workers, not only detached processes", async () => {
    const {
      createWorkflowPlan,
      createWorkflowRunSnapshot,
    } = await import("@vykor/coordinator");
    const worker: SessionExecutionRecord = {
      ...task,
      id: "worker-child-1",
      metadata: {
        origin: "child_session",
        executionBackend: "child_agent",
        runtimeExecutionId: "worker-child-1",
      },
    };
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    const workflow = createWorkflowRunSnapshot({
      runId: "wf-cancel-child",
      ownerSession: "session-1",
      status: "running",
      summary: "review running",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      runningTasks: new Map([[
        "review",
        {
          taskId: "review",
          attempt: 1,
          dependencies: [],
          startedAt: 10,
          summary: "Waiting for worker",
          metadata: { workerTaskId: "worker-child-1" },
        },
      ]]),
      createdAt: 1,
    });
    const processes = {
      readOutput: vi.fn(() => ""),
      writeInput: vi.fn(async () => undefined),
      stopExecution: vi.fn(async () => {
        throw new Error("Execution not found: worker-child-1");
      }),
    };
    const childAgents = {
      readOutput: vi.fn(() => ""),
      writeInput: vi.fn(async () => undefined),
      stopExecution: vi.fn(async () => worker),
    };
    let current = workflow;
    const workflows = {
      repositoryKey: "test-workflows",
      list: () => [current],
      load: (runId: string) => runId === current.runId ? current : undefined,
      claim: vi.fn(),
      finish: vi.fn(),
      save: vi.fn((snapshot: typeof workflow) => {
        current = snapshot;
        return snapshot;
      }),
      appendEvent: vi.fn(),
      loadEvents: vi.fn(() => []),
      listSummaries: vi.fn(() => []),
      latest: vi.fn(() => current),
      waitForChange: vi.fn(async () => current),
    };
    const { service } = createService(worker, { processes, childAgents, workflows });

    await expect(service.cancel({
      sessionId: "session-1",
      jobId: "workflow:wf-cancel-child",
      reason: "user cancelled",
    })).resolves.toMatchObject({
      id: "workflow:wf-cancel-child",
      kind: "workflow",
      status: "killed",
    });

    expect(childAgents.stopExecution).toHaveBeenCalledWith("worker-child-1");
    expect(processes.stopExecution).not.toHaveBeenCalled();
  });
});

function durableReader(store: SessionStore) {
  return {
    getSession: (id: string) => store.sessions.get(id),
    listMessages: (id: string) => store.conversations.listMessages(id),
    listMessageParts: (id: string) => store.conversations.listMessageParts(id),
    getRun: (id: string) => store.runs.getRun(id),
    listRunAttempts: (id: string) => store.runs.listRunAttempts(id),
  };
}

function createService(
  projectedTask: SessionExecutionRecord | SessionExecutionRecord[] = task,
  overrides: {
    processes?: {
      readOutput: ReturnType<typeof vi.fn>;
      writeInput: ReturnType<typeof vi.fn>;
      stopExecution: ReturnType<typeof vi.fn>;
    };
    childAgents?: {
      readOutput: ReturnType<typeof vi.fn>;
      writeInput: ReturnType<typeof vi.fn>;
      stopExecution: ReturnType<typeof vi.fn>;
    };
    workflows?: Record<string, unknown>;
    readChildActivity?: ReturnType<typeof vi.fn>;
    waitForSessionTaskChange?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const projectedTasks = Array.isArray(projectedTask) ? projectedTask : [projectedTask];
  const store = {
    getSession: vi.fn((id: string) => id === "session-1" ? { id, cwd: "/repo" } : undefined),
    listSessionTasks: vi.fn(() => projectedTasks),
    getSessionTask: vi.fn((id: string) => projectedTasks.find((candidate) => candidate.id === id)),
    updateSessionTask: vi.fn((_id: string, input: Record<string, unknown>) => ({
      ...projectedTasks[0]!,
      ...input,
    })),
    ...(overrides.readChildActivity ? { readChildActivity: overrides.readChildActivity } : {}),
    ...(overrides.waitForSessionTaskChange
      ? { waitForSessionTaskChange: overrides.waitForSessionTaskChange } : {}),
  };
  const terminals = {
    list: vi.fn(async () => [terminal]),
    get: vi.fn(async () => terminal),
    readRequest: vi.fn(async () => ({ terminalId: terminal.id, data: "ready", sequence: 5, truncated: false })),
    write: vi.fn(),
    close: vi.fn(),
    wait: vi.fn(),
  };
  const manager = overrides.processes ?? {
    readOutput: vi.fn(() => "task output"),
    writeInput: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => projectedTasks[0]!),
  };
  const childAgents = overrides.childAgents ?? manager;
  return {
    service: new DaemonJobService(
      store as any,
      terminals as any,
      () => manager,
      () => childAgents,
      (overrides.workflows ?? { list: () => [], load: () => undefined }) as any,
    ),
    store,
    terminals,
    manager,
    childAgents,
  };
}
