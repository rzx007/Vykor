import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildResult,
} from "@vykor/core";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  FileWorkflowRunRepository,
} from "@vykor/coordinator";
import { getDetachedProcessSupervisor, resetExecutionRuntimes } from "@vykor/services/executions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAgentJobHost } from "./local-job-host.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const cwd of createdDirectories.splice(0)) {
    await getDetachedProcessSupervisor({ cwd, sessionId: "session-1" }).aclose();
    resetExecutionRuntimes({ cwd, sessionId: "session-1" });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("LocalAgentJobHost adapter", () => {
  it("returns one shell job for concurrent retries of the same creation request", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });
    const input = {
      requestId: "tool:call-1",
      cwd,
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`,
      description: "print once",
    };

    const [first, retry] = await Promise.all([host.create(input), host.create(input)]);

    expect(retry).toEqual(first);
    await expect(host.list({ sessionId: "session-1", kinds: ["shell"] }))
      .resolves.toHaveLength(1);
    await host.wait({ sessionId: "session-1", jobId: first.jobId, timeoutMs: 2_000 });
  });

  it("prunes expired settled creation requests", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });
    const requests = (host as any).shellRequests as Map<string, any>;
    requests.set("expired", {
      fingerprint: "old",
      result: Promise.resolve({ jobId: "old", label: "old" }),
      createdAt: Date.now() - 700_000,
      settledAt: Date.now() - 700_000,
    });

    const created = await host.create({
      requestId: "fresh",
      cwd,
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e "0"`,
      description: "fresh",
    });

    expect(requests.has("expired")).toBe(false);
    await host.wait({ sessionId: "session-1", jobId: created.jobId, timeoutMs: 2_000 });
  });

  it("rejects reusing a creation request identity with different parameters", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });
    const common = {
      requestId: "tool:call-conflict",
      cwd,
      sessionId: "session-1",
      description: "server",
    };

    const first = await host.create({ ...common, command: `${JSON.stringify(process.execPath)} -e "0"` });
    await expect(host.create({ ...common, command: `${JSON.stringify(process.execPath)} -e "1"` }))
      .rejects.toThrow("request identity conflict");
    await host.wait({ sessionId: "session-1", jobId: first.jobId, timeoutMs: 2_000 });
  });

  it("rejects reusing a creation request identity with different settings", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });
    const common = {
      requestId: "tool:settings-conflict",
      cwd,
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e "0"`,
      description: "server",
    };

    const first = await host.create({ ...common, settings: { model: "first" } as any });
    await expect(host.create({ ...common, settings: { model: "second" } as any }))
      .rejects.toThrow("request identity conflict");
    await host.wait({ sessionId: "session-1", jobId: first.jobId, timeoutMs: 2_000 });
  });

  it("lists, sends to, and waits for a framework child", async () => {
    const cwd = temporaryDirectory();
    let state: AgentChildHandle["state"] = "running";
    let settle!: (result: AgentChildResult) => void;
    const result = new Promise<AgentChildResult>((resolve) => { settle = resolve; });
    const send = vi.fn(async () => ({ sessionId: "child-session", inputId: "input-2", runId: "run-2" }));
    const handle: AgentChildHandle = {
      id: "child-1",
      sessionId: "child-session",
      get state() { return state; },
      result,
      send,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(handle),
      workflowRepository: undefined,
    });

    await expect(host.list({
      sessionId: "session-1",
      kinds: ["agent"],
      statuses: ["running"],
    })).resolves.toEqual([
      expect.objectContaining({ id: "child-1", kind: "agent", status: "running" }),
    ]);

    await host.send({ sessionId: "session-1", jobId: "child-1", data: "continue" });
    expect(send).toHaveBeenCalledWith({ content: "continue" });

    const waiting = host.wait({ sessionId: "session-1", jobId: "child-1", timeoutMs: 1_000 });
    state = "idle";
    settle({ status: "completed", output: "child result" });

    await expect(waiting).resolves.toMatchObject({
      text: "child result",
      timedOut: false,
      snapshot: { id: "child-1", status: "completed" },
    });
  });

  it("rejects a different session owner", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });

    await expect(host.list({ sessionId: "session-2" })).rejects.toThrow("owner session mismatch");
  });

  it("reports a failed child as a fact and keeps the parent job host usable", async () => {
    const cwd = temporaryDirectory();
    const failedHandle: AgentChildHandle = {
      id: "child-failed",
      sessionId: "child-failed-session",
      state: "idle",
      result: Promise.resolve({ status: "failed", output: "tests failed", error: "tests failed" }),
      send: vi.fn(async () => ({ sessionId: "child-failed-session", inputId: "i2", runId: "r2" })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(failedHandle),
      workflowRepository: undefined,
    });

    await expect(host.wait({
      sessionId: "session-1",
      jobId: "child-failed",
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      text: "tests failed",
      timedOut: false,
      snapshot: {
        status: "failed",
        metadata: { failureKind: "failed" },
      },
    });
    await expect(host.list({ sessionId: "session-1" })).resolves.toHaveLength(1);
  });

  it("reads structured Workflow details from the injected repository", async () => {
    const cwd = temporaryDirectory();
    const workflows = new FileWorkflowRunRepository({ dir: join(cwd, "external-workflows") });
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    workflows.save(createWorkflowRunSnapshot({
      runId: "workflow-1",
      ownerSession: "session-1",
      status: "running",
      summary: "review in progress",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: workflows,
    });

    await expect(host.read({ sessionId: "session-1", jobId: "workflow-1" }))
      .resolves.toMatchObject({
        snapshot: { kind: "workflow", status: "running" },
        details: {
          status: "running",
          plan: { executionOrder: ["review"] },
          runningTaskIds: ["review"],
          needsReconciliation: false,
          reconciliationPlan: { actions: [] },
        },
      });
  });

  it("does not discover Workflow files when the repository is disabled", async () => {
    const cwd = temporaryDirectory();
    const workflows = new FileWorkflowRunRepository({ cwd });
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    workflows.save(createWorkflowRunSnapshot({
      runId: "workflow-disabled",
      ownerSession: "session-1",
      status: "running",
      summary: "must remain hidden",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: undefined,
    });

    await expect(host.read({ sessionId: "session-1", jobId: "workflow-disabled" }))
      .rejects.toThrow("Job not found: workflow-disabled");
    await expect(host.list({ sessionId: "session-1", kinds: ["workflow"] }))
      .resolves.toEqual([]);
  });

  it("cancels a Workflow through JobCancel instead of a Workflow action", async () => {
    const cwd = temporaryDirectory();
    const workflows = new FileWorkflowRunRepository({ cwd });
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    workflows.save(createWorkflowRunSnapshot({
      runId: "workflow-cancel",
      ownerSession: "session-1",
      status: "running",
      summary: "queued",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(),
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(),
      workflowRepository: workflows,
    });

    await expect(host.cancel({
      sessionId: "session-1",
      jobId: "workflow-cancel",
      reason: "no longer needed",
    })).resolves.toMatchObject({
      id: "workflow-cancel",
      kind: "workflow",
      status: "killed",
      capabilities: { cancel: false },
    });
    expect(workflows.load("workflow-cancel")).toMatchObject({
      status: "failed",
      termination: "cancelled",
      summary: "no longer needed",
    });
  });

  it("interrupts framework child workers when cancelling a Workflow", async () => {
    const cwd = temporaryDirectory();
    let settle!: (result: AgentChildResult) => void;
    const result = new Promise<AgentChildResult>((resolve) => { settle = resolve; });
    const interrupt = vi.fn(async () => {
      settle({ status: "failed", output: "interrupted", error: "interrupted" });
    });
    const handle: AgentChildHandle = {
      id: "worker-child-1",
      sessionId: "child-session",
      state: "running",
      result,
      send: vi.fn(async () => ({ sessionId: "child-session", inputId: "i1", runId: "r1" })),
      interrupt,
      close: vi.fn(async () => undefined),
    };
    const workflows = new FileWorkflowRunRepository({ cwd });
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    workflows.save(createWorkflowRunSnapshot({
      runId: "workflow-child-cancel",
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
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost({
      cwd,
      sessionId: "session-1",
      childManager: directory(handle),
      workflowRepository: workflows,
    });

    await expect(host.cancel({
      sessionId: "session-1",
      jobId: "workflow-child-cancel",
      reason: "stop the worker",
    })).resolves.toMatchObject({
      id: "workflow-child-cancel",
      kind: "workflow",
      status: "killed",
    });
    expect(interrupt).toHaveBeenCalledWith("stop the worker");
  });
});

function directory(...handles: AgentChildHandle[]): AgentChildDirectory {
  return {
    get: (id) => handles.find((handle) => handle.id === id),
    getBySessionId: (sessionId) => handles.find((handle) => handle.sessionId === sessionId),
    list: () => handles,
  };
}

function temporaryDirectory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-local-jobs-"));
  createdDirectories.push(cwd);
  return cwd;
}
