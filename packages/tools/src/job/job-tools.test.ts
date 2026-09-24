import type { AgentJobHost, JobSnapshot } from "@vykor/jobs";
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
    await jobReadTool.execute({ jobId: "terminal-1", after: 3, maxChars: 40 }, context({ read }));
    expect(read).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      after: 3,
      maxChars: 40,
    });
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
