import type { AgentJobHost, JobSnapshot } from "@vykor/jobs";
import { QueryEngine, ToolRegistry, type StreamEvent } from "@vykor/core";
import { describe, expect, it, vi } from "vitest";

import { jobCancelTool, jobListTool, jobReadTool, jobWaitTool } from "./job-tools.js";

const snapshot: JobSnapshot = {
  id: "terminal-1",
  kind: "terminal",
  label: "dev server",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 2,
};

describe("job tools", () => {
  it.each([300, 420])("bounds a requested %s second wait to a short interval", async (timeoutSeconds) => {
    const wait = vi.fn(async () => ({ text: "", cursor: 4, truncated: false, snapshot, timedOut: true }));
    const result = await jobWaitTool.execute({ jobIds: ["terminal-1"], timeoutSeconds }, context({ wait }));
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining("terminal-1") });
    expect(result.compactSummary).toContain("cursor=4");
    expect(payload(result)).toMatchObject({ results: [{ snapshot: { status: "running" }, timedOut: true }] });
  });

  it("returns a running snapshot before the engine deadline without cancelling the job", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => snapshot);
      const wait = vi.fn(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.timeoutMs));
        return { text: "still working", cursor: 4, truncated: false, snapshot, timedOut: true };
      });
      const registry = new ToolRegistry();
      registry.register(jobWaitTool);
      let request = 0;
      const client = {
        async *streamMessage() {
          if (request++ === 0) {
            yield { type: "tool_use_start" as const, toolUse: {
              type: "tool_use" as const, id: "wait-1", name: "JobWait",
              input: { jobIds: ["terminal-1"], timeoutSeconds: 420 },
            } };
            yield { type: "complete" as const, stopReason: "tool_use" };
          } else {
            yield { type: "text_delta" as const, delta: "The background job is still running." };
            yield { type: "complete" as const, stopReason: "end_turn" };
          }
        },
      };
      const engine = new QueryEngine(client, registry,
        { checkTool: async () => ({ action: "allow" as const }) },
        { execute: async () => ({ blocked: false }) },
        { sessionId: "session-1", toolTimeoutMs: 5_000 });
      engine.setJobs(context({ wait, cancel }).jobs);
      const events: StreamEvent[] = [];
      const running = (async () => {
        for await (const event of engine.submitMessage("Wait for the existing job")) events.push(event);
      })();
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      const ended = events.find((event) => event.type === "tool_use_end");
      expect(ended?.type).toBe("tool_use_end");
      if (ended?.type !== "tool_use_end") throw new Error("Missing wait result");
      expect(ended.result.isError).not.toBe(true);
      expect(payload(ended.result)).toMatchObject({ results: [{ timedOut: true, snapshot: { status: "running" } }] });
      expect(wait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 4_000 }));
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("lists only through the durable session owner", async () => {
    const list = vi.fn(async () => [snapshot]);
    const result = await jobListTool.execute({
      kinds: ["terminal"],
      statuses: ["running"],
      includeFinished: false,
      limit: 5,
    }, context({ list }));
    expect(list).toHaveBeenCalledWith({
      sessionId: "session-1",
      kinds: ["terminal"],
      statuses: ["running"],
      includeFinished: false,
      limit: 5,
    });
    expect(payload(result)).toMatchObject({
      kind: "job",
      action: "list",
      jobs: [{ id: "terminal-1" }],
      window: { limit: 5, returned: 1, possiblyTruncated: false },
    });
  });

  it("bounds the default model-visible list without deleting host history", async () => {
    const list = vi.fn(async () => [snapshot]);
    const result = await jobListTool.execute({}, context({ list }));

    expect(list).toHaveBeenCalledWith({ sessionId: "session-1", limit: 100 });
    expect(payload(result)).toMatchObject({
      window: { limit: 100, returned: 1, possiblyTruncated: false },
    });
  });

  it("treats empty kind and status arrays as omitted filters", async () => {
    const list = vi.fn(async () => [snapshot]);
    const result = await jobListTool.execute({
      kinds: [],
      statuses: [],
      limit: 20,
    }, context({ list }));

    expect(list).toHaveBeenCalledWith({ sessionId: "session-1", limit: 20 });
    expect(payload(result)).toMatchObject({
      jobs: [{ id: "terminal-1" }],
      window: { limit: 20, returned: 1, possiblyTruncated: false },
    });
  });

  it("forwards read cursors and output limits", async () => {
    const read = vi.fn(async () => ({ text: "next", cursor: 4, truncated: false, snapshot }));
    const result = await jobReadTool.execute({ jobId: "terminal-1", after: 3, maxChars: 40 }, context({ read }));
    expect(result.compactSummary).toContain("jobId=terminal-1; status=running; cursor=4");
    expect(result.compactSummary).not.toContain("next");
    expect(read).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      after: 3,
      maxChars: 40,
    });
  });

  it("bounds multi-job summaries and marks omitted earlier jobs", async () => {
    const wait = vi.fn(async (input) => ({ text: "private output", cursor: 1, truncated: false,
      snapshot: { ...snapshot, id: input.jobId, exitCode: null }, timedOut: true }));
    const jobIds = Array.from({ length: 10 }, (_, index) => `job-${index}`);
    const result = await jobWaitTool.execute({ jobIds }, context({ wait }));
    expect(result.compactSummary).toContain("2 earlier jobs omitted");
    expect(result.compactSummary).toContain("jobId=job-9; status=running; cursor=1; exitCode=null");
    expect(result.compactSummary).not.toContain("private output");
  });

  it("waits without turning timeout into cancellation", async () => {
    const wait = vi.fn(async () => ({ text: "", cursor: 4, truncated: false, snapshot, timedOut: true }));
    const cancel = vi.fn(async () => snapshot);
    const result = await jobWaitTool.execute({ jobIds: ["terminal-1"], timeoutSeconds: 2 }, context({ wait, cancel }));
    expect(payload(result)).toMatchObject({
      action: "wait",
      results: [{ jobId: "terminal-1", timedOut: true }],
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("waits for several jobs concurrently through the single-job host protocol", async () => {
    const wait = vi.fn(async (input) => ({
      text: input.jobId,
      cursor: 1,
      truncated: false,
      snapshot: { ...snapshot, id: input.jobId },
      timedOut: false,
    }));
    const result = await jobWaitTool.execute({
      jobIds: ["terminal-1", "task-2"],
      timeoutSeconds: 1,
      after: { "terminal-1": 4, "task-2": 7 },
    }, context({ wait }));

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ jobId: "terminal-1", after: 4 }));
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ jobId: "task-2", after: 7 }));
    expect(payload(result)).toMatchObject({
      results: [
        { jobId: "terminal-1", text: "terminal-1" },
        { jobId: "task-2", text: "task-2" },
      ],
    });
  });

  it("keeps one failed wait from hiding the other job results", async () => {
    const wait = vi.fn(async (input) => {
      if (input.jobId === "missing") throw new Error("Job not found: missing");
      return { text: "done", cursor: 1, truncated: false, snapshot, timedOut: false };
    });
    const result = await jobWaitTool.execute({
      jobIds: ["terminal-1", "missing"],
      timeoutSeconds: 1,
    }, context({ wait }));

    expect(payload(result)).toMatchObject({
      results: [
        { jobId: "terminal-1", text: "done" },
        { jobId: "missing", error: "Job not found: missing" },
      ],
    });
  });

  it("rejects oversized wait batches before starting concurrent waits", async () => {
    const wait = vi.fn();
    const result = await jobWaitTool.execute({
      jobIds: Array.from({ length: 33 }, (_, index) => `job-${index}`),
    }, context({ wait }));

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "jobIds cannot contain more than 32 entries.",
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("cancels through the common host", async () => {
    const cancel = vi.fn(async () => ({ ...snapshot, status: "stopping" as const }));
    await jobCancelTool.execute({ jobId: "terminal-1", reason: "done" }, context({ cancel }));
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1", jobId: "terminal-1", reason: "done" });
  });
});

function context(overrides: Partial<AgentJobHost>) {
  const jobs: AgentJobHost = {
    list: async () => [],
    read: async () => ({ text: "", cursor: 0, truncated: false, snapshot }),
    wait: async () => ({ text: "", cursor: 0, truncated: false, snapshot, timedOut: false }),
    send: async () => undefined,
    cancel: async () => snapshot,
    ...overrides,
  };
  return { cwd: "/repo", sessionId: "session-1", jobs };
}

function payload(result: Awaited<ReturnType<typeof jobListTool.execute>>): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text) as Record<string, unknown>;
}
