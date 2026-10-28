import { describe, expect, it, vi } from "vitest";

import { SessionExecutionProjector, type DetachedProcessRuntime } from "../session-execution-projector.js";

function createContext() {
  return {
    store: {
      createSessionTask: vi.fn(),
      getSessionTask: vi.fn(),
      updateSessionTask: vi.fn(),
    },
    events: { checkpoint: vi.fn(() => 4), publishSince: vi.fn() },
    traceIdForRun: vi.fn((runId: string) => `trace-${runId}`),
    log: vi.fn(),
  };
}

function createTaskManager(overrides: Partial<DetachedProcessRuntime> = {}): DetachedProcessRuntime {
  return {
    readOutput: vi.fn(() => "output"),
    registerExecutionListener: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("SessionExecutionProjector", () => {
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
