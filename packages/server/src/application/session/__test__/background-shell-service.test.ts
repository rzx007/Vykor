import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackgroundShellService } from "../background-shell-service.js";

let testConfigDir: string;
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "oh-background-shell-config-"));
  process.env.VYKOR_CONFIG_DIR = testConfigDir;
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

function createTaskService(options: {
  acquireEnvironment?: (...args: any[]) => Promise<any>;
} = {}) {
  const listeners: Array<(task: any) => void> = [];
  const manager = {
    listExecutions: vi.fn(() => []),
    startShellExecution: vi.fn(async (input) => ({
      id: input.id ?? "manager-task",
      type: "shell",
      status: "running",
      description: input.description,
      cwd: input.cwd,
      metadata: {},
    })),
    getExecution: vi.fn(),
    readOutput: vi.fn(() => "live output"),
    stopExecution: vi.fn(async (taskId) => ({
      id: taskId,
      type: "shell",
      status: "stopped",
      description: "command",
      cwd: "/repo",
      metadata: {},
    })),
    registerExecutionListener: vi.fn((listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
  };
  let durableTask = {
    id: "task-1",
    sessionId: "s1",
    type: "shell",
    status: "running",
    description: "command",
    cwd: "/repo",
    output: "durable output",
    metadata: { taskManagerId: "manager-task" } as Record<string, unknown>,
  };
  const store = {
    getSession: vi.fn(() => ({ id: "s1", cwd: "/repo", status: "running" })),
    listSessions: vi.fn(() => [{ id: "s1", cwd: "/repo", status: "running" }]),
    listSessionTasks: vi.fn(() => [durableTask]),
    getSessionTask: vi.fn(() => durableTask),
    createSessionTask: vi.fn((input) => ({ ...durableTask, ...input })),
    reserveSessionTask: vi.fn((input) => {
      durableTask = { ...durableTask, ...input, status: "pending", metadata: input.metadata };
      return { task: durableTask, created: true };
    }),
    transitionPendingSessionTask: vi.fn((_taskId, input) => {
      if (durableTask.status !== "pending") {
        return { task: durableTask, transitioned: false };
      }
      durableTask = {
        ...durableTask,
        ...input,
        metadata: { ...durableTask.metadata, ...(input.metadata ?? {}) },
      };
      return { task: durableTask, transitioned: true };
    }),
    updateSessionTask: vi.fn((_taskId, input) => {
      durableTask = {
        ...durableTask,
        ...input,
        metadata: { ...durableTask.metadata, ...(input.metadata ?? {}) },
      };
      return durableTask;
    }),
  };
  const executionProjector = {
    trackProcessExecution: vi.fn(),
    syncPersistentExecution: vi.fn(),
  };
  const broadcastSince = vi.fn();
  const checkpoint = vi.fn(() => 7);
  const service = new BackgroundShellService({
    store: store as any,
    executionProjector: executionProjector as any,
    getDetachedProcessSupervisor: () => manager as any,
    events: { checkpoint, publishSince: broadcastSince },
    getSettingsForCwd: async () => ({ model: "test" } as any),
    acquireEnvironment: options.acquireEnvironment,
  });
  return { service, store, executionProjector, manager, checkpoint, broadcastSince, listeners };
}

describe("BackgroundShellService", () => {
  it("holds a background environment lease until the process finishes", async () => {
    const release = vi.fn(async () => {});
    const acquireEnvironment = vi.fn(async () => ({
      release,
      workspace: { executionRoot: "/mnt/d/repo" },
      process: {
        execShell: vi.fn(),
        execProcess: vi.fn(),
      },
    }));
    const { service, listeners } = createTaskService({ acquireEnvironment });

    const result = await service.create({
      requestId: "tool:lease",
      sessionId: "s1",
      command: "long-running",
      origin: "tool",
    });

    expect(acquireEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.any(Object),
      { kind: "background", id: result.execution.id },
    );
    expect(release).not.toHaveBeenCalled();
    for (const listener of listeners) listener({ ...result.execution, status: "completed" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
  it("marks an active durable task interrupted when recovery finds no runtime", async () => {
    const { service, store } = createTaskService();

    await expect(service.reconcileActiveTasks("runtime gone")).resolves.toBe(1);
    expect(store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "interrupted",
      error: "runtime gone",
      metadata: { admissionPhase: "runtime_missing" },
    });
  });

  it("reattaches an active durable task when its runtime still exists", async () => {
    const { service, store, manager, executionProjector } = createTaskService();
    const runtime = {
      id: "manager-task",
      type: "shell",
      status: "running",
      description: "command",
      cwd: "/repo",
      metadata: {},
    };
    manager.getExecution.mockReturnValue(runtime);

    await expect(service.reconcileActiveTasks()).resolves.toBe(1);
    expect(executionProjector.trackProcessExecution).toHaveBeenCalledWith(manager, "manager-task");
    expect(executionProjector.syncPersistentExecution).toHaveBeenCalledWith(runtime, manager, "task-1");
    expect(store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      metadata: { admissionPhase: "recovered_live" },
    });
  });

  it("stops an orphan runtime without reverting its durable terminal state", async () => {
    const { service, store, manager } = createTaskService();
    store.updateSessionTask("task-1", { status: "completed" });
    manager.getExecution.mockReturnValue({
      id: "manager-task",
      type: "shell",
      status: "running",
      description: "command",
      cwd: "/repo",
      metadata: {},
    });

    await expect(service.reconcileActiveTasks()).resolves.toBe(1);
    expect(manager.stopExecution).toHaveBeenCalledWith("manager-task");
    expect(store.updateSessionTask).toHaveBeenLastCalledWith("task-1", {
      metadata: { admissionPhase: "orphan_runtime_stopped" },
    });
    expect(store.getSessionTask().status).toBe("completed");
  });

  it("includes archived sessions when reconciling orphan runtimes", async () => {
    const { service, store, manager } = createTaskService();
    store.listSessions.mockReturnValue([{ id: "s1", cwd: "/repo", status: "archived" }]);
    store.updateSessionTask("task-1", { status: "completed" });
    manager.getExecution.mockReturnValue({
      id: "manager-task",
      type: "shell",
      status: "running",
      description: "command",
      cwd: "/repo",
      metadata: {},
    });

    await expect(service.reconcileActiveTasks()).resolves.toBe(1);

    expect(store.listSessions).toHaveBeenCalledWith({ includeArchived: true });
    expect(manager.stopExecution).toHaveBeenCalledWith("manager-task");
    expect(store.getSessionTask().status).toBe("completed");
  });

  it("creates a session shell task and its durable projection", async () => {
    const { service, store, executionProjector, broadcastSince } = createTaskService();

    const result = await service.create({ requestId: "http:create-1", sessionId: "s1", command: "pnpm test" });
    const task = result.execution as { id: string };

    expect(task.id).toMatch(/^task_/);
    expect(store.reserveSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      sessionId: "s1",
      cwd: "/repo",
      requestNamespace: "http",
      requestId: "http:create-1",
      metadata: expect.objectContaining({
        origin: "http",
        admissionPhase: "reserved",
        executionBackend: "detached_process",
      }),
    }));
    expect(store.updateSessionTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      metadata: { admissionPhase: "dispatching" },
    }));
    expect(store.transitionPendingSessionTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "running",
      metadata: expect.objectContaining({ admissionPhase: "confirmed", runtimeExecutionId: task.id }),
    }));
    expect(executionProjector.trackProcessExecution).toHaveBeenCalledWith(expect.anything(), task.id);
    expect(executionProjector.syncPersistentExecution).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.anything());
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("passes tool settings to the process runtime and records the creation origin", async () => {
    const { service, store, manager } = createTaskService();
    const settings = { model: "test-model" } as any;

    const result = await service.create({
      requestId: "tool:create-2",
      sessionId: "s1",
      command: "pnpm dev",
      settings,
      origin: "tool",
    });

    expect(manager.startShellExecution).toHaveBeenCalledWith(expect.objectContaining({ settings }));
    expect(store.reserveSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      id: result.execution.id,
      requestNamespace: "tool",
      metadata: expect.objectContaining({ origin: "tool" }),
    }));
  });

  it("advances the event cursor after each published admission phase", async () => {
    const { service, checkpoint, broadcastSince } = createTaskService();
    checkpoint
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(12);

    await service.create({
      requestId: "http:event-cursor",
      sessionId: "s1",
      command: "pnpm dev",
    });

    expect(broadcastSince.mock.calls).toEqual([[10], [11], [12]]);
  });

  it("uses durable output when manager output is unavailable after restart", () => {
    const { service, manager } = createTaskService();
    manager.readOutput.mockImplementation(() => {
      throw new Error("manager task is gone");
    });

    const result = service.get("task-1", { sessionId: "s1" });

    expect(result).toMatchObject({ output: "durable output" });
  });

  it("does not start a process when durable reservation fails", async () => {
    const { service, store, manager } = createTaskService();
    const reservationError = new Error("database unavailable");
    store.reserveSessionTask.mockImplementation(() => { throw reservationError; });

    await expect(service.create({
      requestId: "http:reserve-failure",
      sessionId: "s1",
      command: "pnpm test",
    })).rejects.toBe(reservationError);
    expect(manager.startShellExecution).not.toHaveBeenCalled();
  });

  it("rejects a session-scoped cwd override before reserving or starting anything", async () => {
    const { service, store, manager } = createTaskService();

    await expect(service.create({
      requestId: "http:wrong-cwd",
      sessionId: "s1",
      cwd: "/another-repo",
      command: "pnpm dev",
    })).rejects.toMatchObject({ status: 409, message: "Background shell cwd mismatch" });

    expect(store.reserveSessionTask).not.toHaveBeenCalled();
    expect(manager.startShellExecution).not.toHaveBeenCalled();
  });

  it.each(["closing", "archived"])(
    "does not admit new work for a %s session",
    async (status) => {
      const { service, store, manager } = createTaskService();
      store.getSession.mockReturnValue({ id: "s1", cwd: "/repo", status });

      await expect(service.create({
        requestId: `http:${status}`,
        sessionId: "s1",
        command: "pnpm dev",
      })).rejects.toMatchObject({ status: 409 });

      expect(store.reserveSessionTask).not.toHaveBeenCalled();
      expect(manager.startShellExecution).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed durable task when process startup fails", async () => {
    const { service, store, manager } = createTaskService();
    manager.startShellExecution.mockRejectedValue(new Error("spawn denied"));

    await expect(service.create({
      requestId: "http:start-failure",
      sessionId: "s1",
      command: "pnpm test",
    })).rejects.toThrow("spawn denied");
    expect(store.transitionPendingSessionTask).toHaveBeenLastCalledWith(expect.any(String), {
      status: "failed",
      error: "spawn denied",
      metadata: { admissionPhase: "failed" },
    });
  });

  it("stops a process that confirms after its pending reservation was cancelled", async () => {
    const { service, store, manager } = createTaskService();
    let confirm!: (task: any) => void;
    manager.startShellExecution.mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
    const creating = service.create({
      requestId: "http:cancel-race",
      sessionId: "s1",
      command: "pnpm dev",
    });
    await Promise.resolve();
    const reservedId = store.reserveSessionTask.mock.calls[0]![0].id;
    store.updateSessionTask(reservedId, { status: "stopped" });
    confirm({
      id: reservedId,
      type: "shell",
      status: "running",
      description: "pnpm dev",
      cwd: "/repo",
      metadata: {},
    });

    await expect(creating).resolves.toMatchObject({
      execution: { id: reservedId, status: "stopped" },
      created: true,
    });
    expect(manager.stopExecution).toHaveBeenCalledWith(reservedId);
  });

  it("returns the existing job when the same request is retried", async () => {
    const { service, store, manager } = createTaskService();
    const input = { requestId: "tool:retry", sessionId: "s1", command: "pnpm dev", origin: "tool" as const };
    const first = await service.create(input);
    const durable = store.getSessionTask();
    store.reserveSessionTask.mockReturnValue({ task: durable, created: false });
    manager.getExecution.mockReturnValue(first.execution);

    const retry = await service.create(input);

    expect(retry.execution.id).toBe(first.execution.id);
    expect(manager.startShellExecution).toHaveBeenCalledTimes(1);
  });

  it("makes a concurrent retry wait for the first process startup", async () => {
    const { service, store, manager } = createTaskService();
    const originalReserve = store.reserveSessionTask.getMockImplementation()!;
    let reservationCount = 0;
    store.reserveSessionTask.mockImplementation((input) => {
      reservationCount += 1;
      return reservationCount === 1
        ? originalReserve(input)
        : { task: store.getSessionTask(), created: false };
    });
    let finishStart!: (task: any) => void;
    const starting = new Promise<any>((resolve) => { finishStart = resolve; });
    manager.startShellExecution.mockImplementation(() => starting);
    manager.getExecution.mockImplementation((id) => ({
      id,
      type: "shell",
      status: "running",
      description: "pnpm dev",
      cwd: "/repo",
      sessionId: "s1",
      metadata: {},
    }));
    const input = {
      requestId: "tool:concurrent-retry",
      sessionId: "s1",
      command: "pnpm dev",
      origin: "tool" as const,
    };

    const first = service.create(input);
    await Promise.resolve();
    await Promise.resolve();
    const retry = service.create(input);
    let retrySettled = false;
    void retry.then(() => { retrySettled = true; });
    await Promise.resolve();

    expect(retrySettled).toBe(false);
    const taskId = store.getSessionTask().id;
    finishStart({
      id: taskId,
      type: "shell",
      status: "running",
      description: "pnpm dev",
      cwd: "/repo",
      sessionId: "s1",
      metadata: {},
    });

    await expect(Promise.all([first, retry])).resolves.toMatchObject([
      { execution: { id: taskId }, created: true },
      { execution: { id: taskId }, created: false },
    ]);
    expect(manager.startShellExecution).toHaveBeenCalledTimes(2);
  });

  it("rejects the same request identity with different parameters", async () => {
    const { service, store, manager } = createTaskService();
    const input = { requestId: "tool:conflict", sessionId: "s1", command: "pnpm dev", origin: "tool" as const };
    await service.create(input);
    const durable = store.getSessionTask();
    store.reserveSessionTask.mockReturnValue({
      task: { ...durable, metadata: { ...durable.metadata, requestFingerprint: "different" } },
      created: false,
    });

    await expect(service.create({ ...input, command: "pnpm test" }))
      .rejects.toMatchObject({ status: 409 });
    expect(manager.startShellExecution).toHaveBeenCalledTimes(1);
  });

  it("rejects the same request identity when execution settings differ", async () => {
    const { service, store, manager } = createTaskService();
    const input = {
      requestId: "tool:settings-conflict",
      sessionId: "s1",
      command: "pnpm dev",
      origin: "tool" as const,
      settings: { model: "first-model" } as any,
    };
    await service.create(input);
    const durable = store.getSessionTask();
    store.reserveSessionTask.mockReturnValue({ task: durable, created: false });

    await expect(service.create({
      ...input,
      settings: { model: "second-model" } as any,
    })).rejects.toMatchObject({ status: 409 });
    expect(manager.startShellExecution).toHaveBeenCalledTimes(1);
  });
});
