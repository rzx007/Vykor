import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { workflowLifecycleScenarios } from "../../../../../tests/workflow/lifecycle-scenarios.js";
import { FileWorkflowRunRepository } from "./file-workflow-run-repository.js";
import { MemoryWorkflowRunRepository } from "./memory-workflow-run-repository.js";
import { WorkflowHost } from "./workflow-host.js";

workflowLifecycleScenarios("memory", () => ({
  repository: new MemoryWorkflowRunRepository(),
}));
workflowLifecycleScenarios("file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vykor-workflow-p3-"));
  return {
    repository: new FileWorkflowRunRepository({ dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

describe("workflow persistence failures", () => {
  it("drains a live worker even when reading its saved snapshot fails", async () => {
    const repository = new MemoryWorkflowRunRepository();
    const host = new WorkflowHost(repository);
    let interrupted = false;
    const work = host.runPersistentWorkflow({ mode: "parallel", tasks: [{ id: "work" }] }, async ({ signal }) => {
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => { interrupted = true; resolve(); }, { once: true }));
      return { summary: "worker settled" };
    }, { runId: "unreadable" });
    vi.spyOn(repository, "load").mockImplementation(() => { throw new Error("snapshot unreadable"); });
    await expect(host.close()).rejects.toThrow("Workflow shutdown failed");
    await work;
    expect(interrupted).toBe(true);
  });
  it("shares one owner-close result and preserves a terminal-save failure", async () => {
    const repository = new MemoryWorkflowRunRepository();
    const host = new WorkflowHost(repository);
    const bound = host.bind({ cwd: "/work", sessionId: "owner" });
    const work = host.runPersistentWorkflow({ mode: "parallel", tasks: [{ id: "work" }] }, async ({ signal }) => {
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { summary: "cleaned up" };
    }, { runId: "closing", ownerSession: "owner" });
    vi.spyOn(repository, "save").mockImplementation(() => { throw new Error("close save failed"); });
    const closing = bound.close();
    expect(bound.close()).toBe(closing);
    await expect(closing).rejects.toThrow("Workflow shutdown failed");
    await work;
    expect(bound.close()).toBe(closing);
    await expect(bound.close()).rejects.toThrow("Workflow shutdown failed");
    await expect(host.close()).rejects.toThrow("Workflow shutdown failed");
  });
  it("uses the captured Run catalog and rejects roles from another plugin before dispatch", async () => {
    const repository = new MemoryWorkflowRunRepository();
    const host = new WorkflowHost(repository);
    const createRunner = vi.fn();
    const bound = host.bind({
      cwd: "/work",
      sessionId: "owner",
      definitions: [
        { name: "private-b", description: "B", systemPrompt: "private B" },
      ],
      createRunner,
    });
    const signal = new AbortController().signal;
    const scope = {
      agentId: "a",
      sessionId: "owner",
      runId: "r",
      inputId: "i",
      traceId: "t",
      cwd: "/work",
      signal,
    };
    const result = await bound.invoke({
      input: {
        mode: "parallel",
        tasks: [{ id: "leak", subagentType: "private-b" }],
      },
      scope,
      signal,
      definitions: [{ name: "private-a", description: "A" }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "not available in this run",
    );
    expect(createRunner).not.toHaveBeenCalled();
    expect(repository.list()).toEqual([]);
    await host.close();
  });
  it("does not dispatch workers when the initial save fails", () => {
    const repository = new MemoryWorkflowRunRepository();
    vi.spyOn(repository, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    const runner = vi.fn();
    expect(() =>
      new WorkflowHost(repository).runPersistentWorkflow(
        { mode: "parallel", tasks: [{ id: "work" }] },
        runner,
      ),
    ).toThrow("disk full");
    expect(runner).not.toHaveBeenCalled();
  });
  it("does not return cancellation success when the terminal save fails", async () => {
    const repository = new MemoryWorkflowRunRepository();
    const host = new WorkflowHost(repository);
    await host.runPersistentWorkflow(
      { mode: "parallel", tasks: [{ id: "work" }] },
      async () => ({ summary: "done" }),
      { runId: "saved" },
    );
    const snapshot = repository.load("saved")!;
    repository.save({ ...snapshot, status: "running" });
    vi.spyOn(repository, "save").mockImplementation(() => {
      throw new Error("terminal save failed");
    });
    await expect(host.cancelPersistentWorkflow("saved")).rejects.toThrow(
      "terminal save failed",
    );
    expect(repository.load("saved")?.status).toBe("running");
    await host.close();
  });
});
