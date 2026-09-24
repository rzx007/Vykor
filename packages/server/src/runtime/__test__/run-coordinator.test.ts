import { describe, expect, it } from "vitest";
import {
  AgentRunNotAcceptingInputError,
  type AgentRunHandle,
} from "@vykor/core";

import {
  RunInterruptedError,
  SessionRunCoordinator,
} from "../run-coordinator.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionRunCoordinator", () => {
  it("serializes runs for the same session", async () => {
    const coordinator = new SessionRunCoordinator();
    const firstRelease = deferred();
    const order: string[] = [];

    const first = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      work: async () => {
        order.push("r1:start");
        await firstRelease.promise;
        order.push("r1:end");
      },
    });
    const second = coordinator.enqueue({
      sessionId: "s1",
      runId: "r2",
      work: async () => {
        order.push("r2:start");
      },
    });

    expect(first.state).toBe("running");
    expect(second.state).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["r1:start"]);

    firstRelease.resolve();
    await Promise.all([first.promise, second.promise]);
    expect(order).toEqual(["r1:start", "r1:end", "r2:start"]);
  });

  it("allows different sessions to run concurrently", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const order: string[] = [];

    const a = coordinator.enqueue({
      sessionId: "s1",
      runId: "a",
      work: async () => {
        order.push("a:start");
        await release.promise;
      },
    });
    const b = coordinator.enqueue({
      sessionId: "s2",
      runId: "b",
      work: async () => {
        order.push("b:start");
        await release.promise;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(order.sort()).toEqual(["a:start", "b:start"]);
    release.resolve();
    await Promise.all([a.promise, b.promise]);
  });

  it("routes steer input into the active framework run handle", async () => {
    const coordinator = new SessionRunCoordinator();
    const registered = deferred();
    const release = deferred();
    const steered: string[] = [];
    const handle: AgentRunHandle = {
      id: "r1",
      inputId: "i1",
      sessionId: "s1",
      traceId: "t1",
      started: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
      result: Promise.resolve({
        status: "completed",
        output: "",
        history: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      steer: async (input) => {
        steered.push(input.content);
        return { sessionId: "s1", inputId: input.id ?? "steer", runId: "r1" };
      },
      interrupt: async () => {},
    };

    const run = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      work: async (context) => {
        await registered.promise;
        await context.registerHandle(handle);
        await release.promise;
      },
    });

    const first = coordinator.steer("s1", { content: "first" });
    expect(coordinator.steer("missing", { content: "ignored" })).toEqual({
      merged: false,
    });
    registered.resolve();
    expect(first).toMatchObject({ merged: true, activeRunId: "r1" });
    const second = coordinator.steer("s1", { content: "second" });
    expect(second).toMatchObject({ merged: true, activeRunId: "r1" });
    release.resolve();
    await run.promise;
    if (!first.merged || !second.merged)
      throw new Error("Expected steer delivery handles");
    await expect(first.delivery).resolves.toEqual({ runId: "r1" });
    await expect(second.delivery).resolves.toEqual({ runId: "r1" });
    expect(steered).toEqual(["first", "second"]);
  });

  it("recovers a steer rejected at the framework terminal boundary", async () => {
    const coordinator = new SessionRunCoordinator();
    const rejected: string[] = [];
    const handle: AgentRunHandle = {
      id: "r1",
      inputId: "i1",
      sessionId: "s1",
      traceId: "t1",
      started: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
      result: Promise.resolve({
        status: "completed",
        output: "",
        history: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      steer: async () => {
        throw new AgentRunNotAcceptingInputError("r1");
      },
      interrupt: async () => {},
    };
    const release = deferred();
    const run = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      onSteerRejected: async (input) => {
        rejected.push(input.content);
        return "r2";
      },
      work: async (context) => {
        await context.registerHandle(handle);
        await release.promise;
      },
    });

    const steered = coordinator.steer("s1", { content: "late" });
    expect(steered).toMatchObject({ merged: true, activeRunId: "r1" });
    release.resolve();
    await run.promise;

    if (!steered.merged) throw new Error("Expected steer delivery handle");
    await expect(steered.delivery).resolves.toEqual({ runId: "r2" });
    expect(rejected).toEqual(["late"]);
  });

  it("rejects steer delivery when replacement run creation fails", async () => {
    const coordinator = new SessionRunCoordinator();
    const handle: AgentRunHandle = {
      id: "r1",
      inputId: "i1",
      sessionId: "s1",
      traceId: "t1",
      started: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
      result: Promise.resolve({
        status: "completed",
        output: "",
        history: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      steer: async () => {
        throw new AgentRunNotAcceptingInputError("r1");
      },
      interrupt: async () => {},
    };
    const release = deferred();
    const run = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      onSteerRejected: async () => {
        throw new Error("replacement failed");
      },
      work: async (context) => {
        await context.registerHandle(handle);
        await release.promise;
      },
    });

    const steered = coordinator.steer("s1", { content: "late" });
    if (!steered.merged) throw new Error("Expected steer delivery handle");
    await expect(steered.delivery).rejects.toThrow("replacement failed");
    release.resolve();
    await expect(run.promise).rejects.toThrow("replacement failed");
  });

  it("recovers steer queued before a handle when work settles without registering one", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const run = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      onSteerRejected: async () => "r2",
      work: async () => {
        await release.promise;
      },
    });
    const steered = coordinator.steer("s1", { content: "early" });
    if (!steered.merged) throw new Error("Expected steer delivery handle");

    release.resolve();

    await expect(steered.delivery).resolves.toEqual({ runId: "r2" });
    await expect(run.promise).resolves.toBeUndefined();
  });

  it("promotes one queued run into the exact active run", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const steered: string[] = [];
    const handle: AgentRunHandle = {
      id: "active",
      inputId: "active-input",
      sessionId: "s1",
      traceId: "trace-active",
      started: Promise.resolve({
        sessionId: "s1",
        inputId: "active-input",
        runId: "active",
      }),
      result: Promise.resolve({
        status: "completed",
        output: "",
        history: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      steer: async (input) => {
        steered.push(input.content);
        return { sessionId: "s1", inputId: input.id!, runId: "active" };
      },
      interrupt: async () => {},
    };
    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      work: async (context) => {
        await context.registerHandle(handle);
        await release.promise;
      },
    });
    const queued = coordinator.enqueue({
      sessionId: "s1",
      runId: "queued",
      work: async () => {
        throw new Error("promoted queue must not start");
      },
    });

    const promoted = coordinator.promoteQueuedRun("s1", "queued", "active", {
      id: "queued-input",
      content: "adjust direction",
      delivery: "steer",
    });

    expect(promoted).toMatchObject({
      promoted: true,
      activeRunId: "active",
      queuedRunId: "queued",
    });
    if (!promoted.promoted) throw new Error("Expected promotion handle");
    await expect(promoted.delivery).resolves.toEqual({ runId: "active" });
    await expect(queued.promise).rejects.toThrow(
      "promoted into the active run",
    );
    expect(coordinator.queuedRunIds("s1")).toEqual([]);
    expect(steered).toEqual(["adjust direction"]);
    release.resolve();
    await active.promise;
  });

  it("restores the queued run when promotion is rejected", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const handle: AgentRunHandle = {
      id: "active",
      inputId: "active-input",
      sessionId: "s1",
      traceId: "trace-active",
      started: Promise.resolve({
        sessionId: "s1",
        inputId: "active-input",
        runId: "active",
      }),
      result: Promise.resolve({
        status: "completed",
        output: "",
        history: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      steer: async () => {
        throw new AgentRunNotAcceptingInputError("active");
      },
      interrupt: async () => {},
    };
    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      work: async (context) => {
        await context.registerHandle(handle);
        await release.promise;
      },
    });
    const queued = coordinator.enqueue({
      sessionId: "s1",
      runId: "queued",
      work: async () => {},
    });

    const promoted = coordinator.promoteQueuedRun("s1", "queued", "active", {
      id: "queued-input",
      content: "too late",
      delivery: "steer",
    });
    if (!promoted.promoted) throw new Error("Expected promotion handle");
    await expect(promoted.delivery).rejects.toBeInstanceOf(
      AgentRunNotAcceptingInputError,
    );
    expect(coordinator.queuedRunIds("s1")).toEqual(["queued"]);

    release.resolve();
    await Promise.all([active.promise, queued.promise]);
  });

  it("restores the queued run when the active run ends before registering a handle", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      onSteerRejected: async () => "replacement",
      work: async () => await release.promise,
    });
    const queued = coordinator.enqueue({
      sessionId: "s1",
      runId: "queued",
      work: async () => {},
    });
    const promoted = coordinator.promoteQueuedRun("s1", "queued", "active", {
      id: "queued-input",
      content: "late",
      delivery: "steer",
    });
    if (!promoted.promoted) throw new Error("Expected promotion handle");

    release.resolve();
    await expect(promoted.delivery).rejects.toBeInstanceOf(
      AgentRunNotAcceptingInputError,
    );
    await Promise.all([active.promise, queued.promise]);
  });

  it("interrupts the active run and rejects queued runs", async () => {
    const coordinator = new SessionRunCoordinator();
    const activeInterrupted = deferred();
    let abortReason: unknown;

    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      work: async (context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              abortReason = context.signal.reason;
              activeInterrupted.resolve();
              resolve();
            },
            { once: true },
          );
        });
        throw new RunInterruptedError();
      },
    });
    const queued = coordinator.enqueue({
      sessionId: "s1",
      runId: "queued",
      work: async () => {
        throw new Error("should not run");
      },
    });

    const result = coordinator.interrupt("s1", "Daemon shutting down");
    expect(result).toEqual({
      activeRunId: "active",
      queuedRunIds: ["queued"],
      interrupted: true,
    });
    await activeInterrupted.promise;
    expect(abortReason).toBe("Daemon shutting down");
    await expect(active.promise).rejects.toBeInstanceOf(RunInterruptedError);
    await expect(queued.promise).rejects.toThrow("Daemon shutting down");
  });

  it("never interrupts an active run through the queued-only operation", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      work: async () => await release.promise,
    });

    expect(
      coordinator.interruptQueuedRun("s1", "active", "cancel pending"),
    ).toEqual({
      activeRunId: "active",
      queuedRunIds: [],
      interrupted: false,
    });

    release.resolve();
    await active.promise;
  });
});
