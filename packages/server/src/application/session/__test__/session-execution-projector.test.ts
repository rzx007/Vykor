import { describe, expect, it, vi } from "vitest";

import { SessionExecutionProjector, type ChildAgentRegistry, type DetachedProcessRuntime } from "../session-execution-projector.js";

function createContext() {
  return {
    store: {
      createSessionTask: vi.fn(),
      getSessionTask: vi.fn(),
      updateSessionTask: vi.fn(),
    },
    getChildAgentExecutionRegistry: vi.fn(() => createTaskManager()),
    events: { checkpoint: vi.fn(() => 4), publishSince: vi.fn() },
    traceIdForRun: vi.fn((runId: string) => `trace-${runId}`),
    log: vi.fn(),
  };
}

function createTaskManager(overrides: Partial<ChildAgentRegistry & DetachedProcessRuntime> = {}): ChildAgentRegistry & DetachedProcessRuntime {
  return {
    beginExecution: vi.fn(),
    completeExecution: vi.fn(),
    listExecutions: vi.fn(() => []),
    readOutput: vi.fn(() => "output"),
    registerChildExecution: vi.fn(),
    registerExecutionListener: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("SessionExecutionProjector", () => {
  it("does not register a live task when durable task creation fails", () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.createSessionTask.mockImplementation(() => { throw new Error("store unavailable"); });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerChildExecution(childTaskInput())).toThrow("store unavailable");
    expect(manager.registerChildExecution).not.toHaveBeenCalled();
  });

  it("marks the durable task failed when live task registration fails", () => {
    const context = createContext();
    const manager = createTaskManager({
      registerChildExecution: vi.fn(() => { throw new Error("manager unavailable"); }),
    });
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerChildExecution(childTaskInput())).toThrow("manager unavailable");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "manager unavailable",
      error: "manager unavailable",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("persists terminal state even when live task completion fails", async () => {
    const context = createContext();
    const manager = createTaskManager({
      completeExecution: vi.fn(async () => { throw new Error("manager unavailable"); }),
    });
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue({ id: "task-1", sessionId: "s1", runId: "run-1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    await expect(bridge.completeChildExecution("task-1", { status: "completed", output: "done" })).resolves.toBeUndefined();
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "completed",
      output: "done",
    });
    expect(context.log).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "session.execution.registry_completion_failed",
      error: "manager unavailable",
    }));
  });

  it("persists trusted child failure detail with the terminal task", async () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue({ id: "task-1", sessionId: "s1", runId: "run-1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });
    const partialResult = {
      version: 1 as const,
      childSessionId: "child-1",
      runId: "run-1",
      source: "limit_finalization" as const,
      text: "final report",
      truncated: false,
    };

    await bridge.completeChildExecution("task-1", {
      status: "failed",
      output: "Exceeded maximum agentic turns (2)",
      failureKind: "max_turns",
      partialResult,
    });

    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "Exceeded maximum agentic turns (2)",
      error: "Exceeded maximum agentic turns (2)",
      metadata: { childFailure: { failureKind: "max_turns", partialResult } },
    });
  });

  it("does not fabricate child failure metadata for an ordinary failure", async () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue({ id: "task-1", sessionId: "s1", runId: "run-1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    await bridge.completeChildExecution("task-1", { status: "failed", output: "boom" });

    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "boom",
      error: "boom",
    });
  });

  it("moves both live and durable task state back to running when a child starts another run", async () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    await bridge.bindChildExecutionRun("task-1", "run-2");

    expect(manager.beginExecution).toHaveBeenCalledWith("task-1");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "running",
      runId: "run-2",
    });
  });

  it("syncs failed task output into durable state", () => {
    const context = createContext();
    const manager = createTaskManager({
      readOutput: vi.fn(() => "boom"),
    });
    const bridge = new SessionExecutionProjector(context);

    bridge.syncPersistentExecution({
      id: "task-1",
      type: "shell",
      status: "failed",
      description: "npm test",
      cwd: "/repo",
      metadata: {},
    }, manager, "durable-1");

    expect(context.store.updateSessionTask).toHaveBeenCalledWith("durable-1", {
      status: "failed",
      output: "boom",
      error: "boom",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("merges a real process exit result into durable metadata", () => {
    const context = createContext();
    const manager = createTaskManager({ readOutput: vi.fn(() => "all passed") });
    const projector = new SessionExecutionProjector(context);
    projector.syncPersistentExecution({
      id: "process-1", type: "shell", status: "failed", description: "tests",
      cwd: "/repo", metadata: {}, processExitCode: 7,
    }, manager, "durable-1");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("durable-1", {
      status: "failed", output: "all passed", error: "all passed",
      metadata: { processExitCode: 7 },
    });
  });

  it("rejects malformed or unrelated runtime log metadata", () => {
    const context = createContext();
    const manager = createTaskManager();
    const projector = new SessionExecutionProjector(context);
    for (const value of [0, "0", "01", "-1", "3.5", "oops", null]) {
      projector.syncPersistentExecution({ id: "process-1", type: "shell", status: "running", description: "tests",
        cwd: "/repo", metadata: { outputDiscardedBytes: value, outputWriteFailed: "true", unrelated: "secret" } }, manager);
    }
    expect(context.store.updateSessionTask).toHaveBeenCalledTimes(7);
    for (const call of context.store.updateSessionTask.mock.calls) expect(call[1]).not.toHaveProperty("metadata");
  });

  it("unregisters a process listener after the task reaches a terminal state", () => {
    const context = createContext();
    context.store.getSessionTask.mockReturnValue({
      id: "task-1",
      sessionId: "s1",
      status: "running",
    });
    let listener!: (task: any) => void;
    const unregister = vi.fn();
    const manager = createTaskManager({
      registerExecutionListener: vi.fn((next) => {
        listener = next;
        return unregister;
      }),
    });
    const bridge = new SessionExecutionProjector(context);
    bridge.trackProcessExecution(manager, "task-1");

    listener({
      id: "task-1",
      type: "shell",
      status: "completed",
      description: "npm test",
      cwd: "/repo",
      metadata: {},
    });

    expect(unregister).toHaveBeenCalledOnce();
    bridge.trackProcessExecution(manager, "task-1");
    expect(manager.registerExecutionListener).toHaveBeenCalledTimes(2);
  });

  it("does not regress a durable terminal task from a stale live running snapshot", () => {
    const context = createContext();
    context.store.getSessionTask.mockReturnValue({
      id: "task-1",
      sessionId: "s1",
      status: "completed",
    });
    const manager = createTaskManager();
    const bridge = new SessionExecutionProjector(context);

    bridge.syncPersistentExecution({
      id: "task-1",
      type: "agent",
      status: "running",
      description: "Explore",
      cwd: "/repo",
      metadata: {},
    }, manager);

    expect(context.store.updateSessionTask).not.toHaveBeenCalled();
  });
});

function childTaskInput() {
  return {
    id: "task-1",
    description: "Explore",
    cwd: "/repo",
    sessionId: "s1",
    childSessionId: "child-1",
    prompt: "inspect",
    onInput: async () => {},
    onStop: async () => {},
  };
}
