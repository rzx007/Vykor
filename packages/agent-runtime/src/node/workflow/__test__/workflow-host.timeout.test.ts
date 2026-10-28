import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowPlan, createWorkflowRunSnapshot, type WorkflowSpec } from "@vykor/coordinator/workflow";
import { MemoryWorkflowRunRepository } from "../memory-workflow-run-repository.js";
import { WorkflowHost } from "../workflow-host.js";

describe("Workflow invocation deadlines", () => {
  const hosts: WorkflowHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const repository = new MemoryWorkflowRunRepository();
    const host = new WorkflowHost(repository);
    hosts.push(host);
    const running: Array<{ id: string; signal: AbortSignal; receipt?: Record<string, unknown> }> = [];
    const bound = host.bind({ cwd: "/work", sessionId: "owner", createRunner: () => async ({ task, signal, resumeFrom }) => {
      running.push({ id: task.id, signal: signal!, receipt: resumeFrom?.metadata });
      await new Promise<void>(resolve => {
        signal!.addEventListener("abort", () => resolve(), { once: true });
        if (signal!.aborted) resolve();
      });
      return { summary: "Actual worker stopped" };
    } });
    const signal = new AbortController().signal;
    const scope = { agentId: "owner", sessionId: "owner", runId: "root-run", inputId: "input", traceId: "trace", cwd: "/work", signal };
    return { repository, running, invoke: (input: Record<string, unknown>) => bound.invoke({ input, scope, signal }) };
  }

  it.each([
    { timeoutSeconds: 0.1, expectedMs: 100 },
    { timeoutSeconds: 0.1, defaultTaskTimeoutSeconds: 1, expectedMs: 100 },
    { timeoutSeconds: 1, defaultTaskTimeoutSeconds: 0.1, expectedMs: 100 },
    { timeoutSeconds: 0.1, defaultTaskTimeoutSeconds: 0.01, taskTimeoutSeconds: 1, expectedMs: 100 },
    { timeoutSeconds: 1, defaultTaskTimeoutSeconds: 0.01, taskTimeoutSeconds: 0.1, expectedMs: 100 },
    { timeoutSeconds: 1, defaultTaskTimeoutSeconds: 0.1, taskTimeoutSeconds: 0.01, expectedMs: 10 },
  ])("caps the task override/default with the per-worker timeout: %j", async ({ taskTimeoutSeconds, expectedMs, ...input }) => {
    const { repository, running, invoke } = setup();
    await invoke({ action: "run", runId: "deadline", mode: "parallel", ...input,
      tasks: [{ id: "work", ...(taskTimeoutSeconds === undefined ? {} : { timeoutSeconds: taskTimeoutSeconds }) }] });
    expect(repository.load("deadline")?.spec.tasks[0]?.timeoutMs).toBe(expectedMs);
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(running[0]?.signal.aborted).toBe(false);
    expect(repository.load("deadline")?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(running[0]?.signal.aborted).toBe(true);
    expect(repository.load("deadline")?.results.work).toMatchObject({ status: "failed", timedOut: true, attempts: 1 });
  });

  it("applies the same per-worker deadline to an unpersisted invocation", async () => {
    const { repository, running, invoke } = setup();
    const work = invoke({ action: "run", persist: false, mode: "parallel", timeoutSeconds: 0.1, tasks: [{ id: "work" }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(running[0]?.signal.aborted).toBe(true);
    expect((await work).isError).toBe(true);
    expect(repository.list()).toEqual([]);
  });

  it.each([undefined, 0.05, 1])("resumes the saved task deadline without relaxing it (requested timeout %s)", async timeoutSeconds => {
    const { repository, running, invoke } = setup();
    const spec: WorkflowSpec = { mode: "sequential", tasks: [{ id: "done" }, { id: "remaining", timeoutMs: 100 }] };
    repository.save(createWorkflowRunSnapshot({ runId: "resumed", ownerSession: "owner", status: "running", summary: "Saved work",
      spec, plan: createWorkflowPlan(spec), createdAt: 1, running: new Set(["remaining"]), runningTasks: new Map([["remaining", {
        taskId: "remaining", attempt: 1, dependencies: ["done"], startedAt: 2, summary: "Existing worker running",
        metadata: { workerTaskId: "original-child", workerRunId: "original-run" },
      }]]), results: new Map([["done", {
        taskId: "done", status: "completed", summary: "Already done", attempts: 1, dependencies: [], startedAt: 1, finishedAt: 2,
      }]]) }));
    const work = invoke({ action: "resume", runId: "resumed", ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
    const expectedMs = timeoutSeconds === 0.05 ? 50 : 100;
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(running.map(task => task.id)).toEqual(["remaining"]);
    expect(running[0]?.receipt).toEqual({ workerTaskId: "original-child", workerRunId: "original-run" });
    expect(running[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(running[0]?.signal.aborted).toBe(true);
    expect((await work).isError).toBe(true);
    expect(repository.load("resumed")?.results.done).toMatchObject({ status: "completed", attempts: 1 });
    expect(repository.load("resumed")?.results.remaining).toMatchObject({ status: "failed", timedOut: true });
  });
});
