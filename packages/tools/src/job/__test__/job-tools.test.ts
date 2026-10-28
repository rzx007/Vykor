import { createJobTools } from "../job-tools.js";
import type { AgentJobHost, JobSnapshot } from "@vykor/jobs";
import { type ToolContext, type ToolResult } from "@vykor/agent-contracts";
import { describe, expect, it, vi } from "vitest";


const snapshot: JobSnapshot = {
  id: "terminal-1",
  kind: "terminal",
  target: { kind: "terminal", jobId: "terminal-1" },
  label: "dev server",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 2,
};

describe("job tools", () => {
  it("does not use a context host when no port was injected", async () => {
    const list = vi.fn(async () => ({ jobs: [snapshot], errors: [] }));
    const result = await createJobTools().find(tool => tool.name === "JobList")!.execute({}, context({ list }));
    expect(result.isError).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });
  it("uses the injected host with its method receiver", async () => {
    const host = { ...context({}).jobs, output: "injected", async read() { return { text: this.output, cursor: 8, truncated: false, snapshot }; } };
    const tool = createJobTools(host).find(tool => tool.name === "JobRead")!;
    const result = await tool.execute({ target: { kind: "terminal", jobId: snapshot.id } }, { cwd: "/repo", sessionId: "session-1" });
    expect(payload(result)).toMatchObject({ text: "injected", snapshot: { id: snapshot.id } });
  });
  it.each([300, 420])("bounds a requested %s second wait to a short interval", async (timeoutSeconds) => {
    const wait = vi.fn(async () => ({ text: "", cursor: 4, truncated: false, snapshot, timedOut: true }));
    const result = await executeJob("JobWait", { targets: ["terminal-1"].map(jobId => ({ target: { kind: "terminal", jobId } })), timeoutSeconds }, context({ wait }));
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining("terminal-1") });
    expect(result.compactSummary).toContain("cursor=4");
    expect(payload(result)).toMatchObject({ results: [{ snapshot: { status: "running" }, timedOut: true }] });
  });


  it("lists only through the durable session owner", async () => {
    const list = vi.fn(async () => ({ jobs: [snapshot], errors: [] }));
    const result = await executeJob("JobList", {
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
    const list = vi.fn(async () => ({ jobs: [snapshot], errors: [] }));
    const result = await executeJob("JobList", {}, context({ list }));

    expect(list).toHaveBeenCalledWith({ sessionId: "session-1", limit: 100 });
    expect(payload(result)).toMatchObject({
      window: { limit: 100, returned: 1, possiblyTruncated: false },
    });
  });

  it("treats empty kind and status arrays as omitted filters", async () => {
    const list = vi.fn(async () => ({ jobs: [snapshot], errors: [] }));
    const result = await executeJob("JobList", {
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
    const result = await executeJob("JobRead", { target: { kind: "terminal", jobId: "terminal-1" }, after: 3, maxChars: 40 }, context({ read }));
    expect(result.compactSummary).toContain("jobId=terminal-1; status=running; cursor=4");
    expect(result.compactSummary).not.toContain("next");
    expect(read).toHaveBeenCalledWith({
      sessionId: "session-1",
      target: { kind: "terminal", jobId: "terminal-1" },
      after: 3,
      maxChars: 40,
    });
  });

  it("shows a known unreadable log fact without replacing the supplied cursor", async () => {
    const read = vi.fn(async () => ({ text: "", cursor: 17, truncated: false,
      snapshot: { ...snapshot, status: "completed" as const, metadata: { outputWriteFailed: "1" } },
      details: { outputUnavailable: "Background log could not be read; output may be incomplete." } }));
    const result = await executeJob("JobRead", { target: { kind: "terminal", jobId: "terminal-1" }, after: 17 }, context({ read }));
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({ text: "", cursor: 17, snapshot: { status: "completed", metadata: { outputWriteFailed: "1" } },
      details: { outputUnavailable: expect.stringMatching(/could not be read/i) } });
  });

  it("reports an unknown log read failure without a fabricated cursor", async () => {
    const read = vi.fn(async () => { throw new Error("EISDIR: log read failed"); });
    const result = await executeJob("JobRead", { target: { kind: "terminal", jobId: "terminal-1" }, after: 17 }, context({ read }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("EISDIR");
  });

  it("preserves the complete 41-character task id", async () => {
    const id = `task_${"a".repeat(36)}`;
    const read = vi.fn(async () => ({ text: "", cursor: 2, truncated: false, snapshot: { ...snapshot, id } }));
    const result = await executeJob("JobRead", { target: { kind: "terminal", jobId: id } }, context({ read }));
    expect(result.compactSummary).toContain(`jobId=${id};`);
  });

  it("omits a whole oversized job id instead of inventing a truncated one", async () => {
    const id = `task_${"a".repeat(1100)}`;
    const read = vi.fn(async () => ({ text: "", cursor: 2, truncated: false, snapshot: { ...snapshot, id } }));
    const result = await executeJob("JobRead", { target: { kind: "terminal", jobId: id } }, context({ read }));
    expect(result.compactSummary).toContain("1 observation omitted");
    expect(result.compactSummary).not.toContain("jobId=task_");
    expect(result.compactSummary!.length).toBeLessThanOrEqual(1000);
  });

  it("counts missing snapshots separately from summary omissions", async () => {
    const wait = vi.fn(async (input) => {
      if (input.target.jobId === "missing") throw new Error("not found");
      return { text: "", cursor: 1, truncated: false, snapshot: { ...snapshot, id: input.target.jobId }, timedOut: true };
    });
    const result = await executeJob("JobWait", { targets: ["missing", "terminal-1"].map(jobId => ({ target: { kind: "terminal", jobId } })) }, context({ wait }));
    expect(result.compactSummary).toContain("1 observation without snapshot");
    expect(result.compactSummary).not.toContain("omitted");
  });

  it("bounds multi-job summaries and marks omitted earlier jobs", async () => {
    const wait = vi.fn(async (input) => ({ text: "private output", cursor: 1, truncated: false,
      snapshot: { ...snapshot, id: input.target.jobId, exitCode: null }, timedOut: true }));
    const jobIds = Array.from({ length: 10 }, (_, index) => `job-${index}`);
    const result = await executeJob("JobWait", { targets: jobIds.map(jobId => ({ target: { kind: "terminal", jobId } })) }, context({ wait }));
    expect(result.compactSummary).toContain("2 observation omitted from summary");
    expect(result.compactSummary).toContain("jobId=job-9; status=running; cursor=1; exitCode=null");
    expect(result.compactSummary).not.toContain("private output");
  });

  it("waits without turning timeout into cancellation", async () => {
    const wait = vi.fn(async () => ({ text: "", cursor: 4, truncated: false, snapshot, timedOut: true }));
    const cancel = vi.fn(async () => snapshot);
    const result = await executeJob("JobWait", { targets: ["terminal-1"].map(jobId => ({ target: { kind: "terminal", jobId } })), timeoutSeconds: 2 }, context({ wait, cancel }));
    expect(payload(result)).toMatchObject({
      action: "wait",
      results: [{ target: { kind: "terminal", jobId: "terminal-1" }, timedOut: true }],
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("waits for several jobs concurrently through the single-job host protocol", async () => {
    const wait = vi.fn(async (input) => ({
      text: input.target.jobId,
      cursor: 1,
      truncated: false,
      snapshot: { ...snapshot, id: input.target.jobId },
      timedOut: false,
    }));
    const result = await executeJob("JobWait", {
      targets: [{ target: { kind: "terminal", jobId: "terminal-1" }, after: 4 }, { target: { kind: "terminal", jobId: "task-2" }, after: 7 }],
      timeoutSeconds: 1,
    }, context({ wait }));

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "terminal", jobId: "terminal-1" }, after: 4 }));
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "terminal", jobId: "task-2" }, after: 7 }));
    expect(payload(result)).toMatchObject({
      results: [
        { target: { kind: "terminal", jobId: "terminal-1" }, text: "terminal-1" },
        { target: { kind: "terminal", jobId: "task-2" }, text: "task-2" },
      ],
    });
  });

  it("keeps one failed wait from hiding the other job results", async () => {
    const wait = vi.fn(async (input) => {
      if (input.target.jobId === "missing") throw new Error("Job not found: missing");
      return { text: "done", cursor: 1, truncated: false, snapshot, timedOut: false };
    });
    const result = await executeJob("JobWait", {
      targets: ["terminal-1", "missing"].map(jobId => ({ target: { kind: "terminal", jobId } })),
      timeoutSeconds: 1,
    }, context({ wait }));

    expect(payload(result)).toMatchObject({
      results: [
        { target: { kind: "terminal", jobId: "terminal-1" }, text: "done" },
        { target: { kind: "terminal", jobId: "missing" }, error: "Job not found: missing" },
      ],
    });
  });

  it("rejects oversized wait batches before starting concurrent waits", async () => {
    const wait = vi.fn();
    const result = await executeJob("JobWait", {
      targets: Array.from({ length: 33 }, (_, index) => ({ target: { kind: "terminal", jobId: `job-${index}` } })),
    }, context({ wait }));

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "targets must contain 1 to 32 entries",
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("cancels through the common host", async () => {
    const cancel = vi.fn(async () => ({ ...snapshot, status: "stopping" as const }));
    await executeJob("JobCancel", { target: { kind: "terminal", jobId: "terminal-1" }, reason: "done" }, context({ cancel }));
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1", target: { kind: "terminal", jobId: "terminal-1" }, reason: "done" });
  });
});

function context(overrides: Partial<AgentJobHost>) {
  const jobs: AgentJobHost = {
    list: async () => ({ jobs: [], errors: [] }),
    read: async () => ({ text: "", cursor: 0, truncated: false, snapshot }),
    wait: async () => ({ text: "", cursor: 0, truncated: false, snapshot, timedOut: false }),
    send: async () => undefined,
    cancel: async () => snapshot,
    ...overrides,
  };
  return { cwd: "/repo", sessionId: "session-1", jobs };
}

function payload(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function executeJob(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return createJobTools(context.jobs).find(tool => tool.name === name)!.execute(input, context);
}

function childFeedbackSnapshot(report: unknown = {
  version: 1, childSessionId: "child-session", runId: "run-1", source: "limit_finalization", text: "private report", truncated: false,
}): JobSnapshot {
  return { ...snapshot, id: "child-1", kind: "agent", target: { kind: "agent", jobId: "child-1", runId: "run-1" }, status: "failed",
    metadata: { childSessionId: "child-session", childFailure: { failureKind: "max_turns", partialResult: report } } };
}

it.each(["JobRead", "JobWait", "JobList"])("keeps child failure facts in bounded %s summaries without failing observation", async name => {
  const child = childFeedbackSnapshot();
  const observation = { text: "private report", cursor: 14, truncated: false, snapshot: child };
  const send = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => child);
  const host = context({ read: async () => observation, wait: async () => ({ ...observation, timedOut: false }), list: async () => ({ jobs: [child], errors: [] }), send, cancel });
  const input = name === "JobList" ? {} : name === "JobRead" ? { target: child.target } : { targets: [{ target: child.target }] };
  const result = await executeJob(name, input, host);
  expect(result.isError).not.toBe(true);
  expect(result.executionState).toBe("completed");
  expect(result.compactSummary).toContain("runId=run-1");
  expect(result.compactSummary).toContain("failureKind=max_turns");
  expect(result.compactSummary).toContain("partialResult=available");
  expect(result.compactSummary).not.toContain("private report");
  expect(result.compactSummary!.length).toBeLessThanOrEqual(1000);
  expect(payload(result)).not.toHaveProperty("outcome");
  expect(send).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

it.each([
  [null, "none"],
  [{ version: 1, childSessionId: "child-session", runId: "other", source: "limit_finalization", text: "report", truncated: false }, "none"],
  [{ version: 2, childSessionId: "child-session", runId: "run-1", source: "limit_finalization", text: "report", truncated: false }, "none"],
  [{ version: 1, childSessionId: "child-session", runId: "run-1", source: "untrusted", text: "report", truncated: false }, "none"],
  [{ version: 1, childSessionId: "child-session", runId: "run-1", source: "limit_finalization", text: " ", truncated: false }, "none"],
  [{ version: 1, childSessionId: "child-session", runId: "run-1", source: "limit_finalization", text: "report", truncated: true }, "available"],
])("does not infer partial report availability from the current output window: %j", async (report, availability) => {
  const child = childFeedbackSnapshot(report);
  const result = await executeJob("JobRead", { target: child.target }, context({ read: async () => ({ snapshot: child, text: "", cursor: 200, truncated: false }) }));
  expect(result.compactSummary).toContain(`partialResult=${availability}`);
  expect(result.compactSummary).toContain("failureKind=max_turns");
});

it.each(["running", "process", "malformed"])("does not classify %s snapshots as terminal child budget failures", async mode => {
  const child = childFeedbackSnapshot();
  if (mode === "running") child.status = "running";
  if (mode === "process") child.metadata = { executionBackend: "detached_process", childFailure: { failureKind: "max_turns" } };
  if (mode === "malformed") child.metadata = { childSessionId: "child-session", childFailure: "max_turns" };
  const result = await executeJob("JobWait", { targets: [{ target: child.target }] }, context({ wait: async () => ({ snapshot: child, text: "", cursor: 0, truncated: false, timedOut: true }) }));
  expect(result.isError).not.toBe(true);
  expect(result.compactSummary).not.toContain("failureKind=max_turns");
});
