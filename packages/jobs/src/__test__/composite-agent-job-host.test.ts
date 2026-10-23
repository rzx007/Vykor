import { describe, expect, it, vi } from "vitest";

import {
  CompositeAgentJobHost,
  filterJobSnapshots,
  type AgentJobHost,
  type JobListRequest,
  type JobReadResult,
  type JobSnapshot,
  type JobWaitResult,
} from "../index.js";

describe("CompositeAgentJobHost", () => {
  it("deduplicates the same source object", async () => {
    const source = fakeJobHost([job("task_1")]);
    const composite = new CompositeAgentJobHost([source, source]);

    await expect(composite.list({ sessionId: "s1" })).resolves.toHaveLength(1);
    expect(source.list).toHaveBeenCalledOnce();
  });

  it("rejects an id claimed by different sources", async () => {
    const composite = new CompositeAgentJobHost([
      fakeJobHost([job("shared")]),
      fakeJobHost([job("shared")]),
    ]);

    await expect(composite.list({ sessionId: "s1" })).rejects.toThrow(
      /Job source conflict: shared/,
    );
  });

  it("filters and limits the merged list after querying every source without a limit", async () => {
    const terminal = fakeJobHost([job("terminal_1", { startedAt: 10 })]);
    const shell = fakeJobHost([job("shell_1", { startedAt: 20 })]);
    const composite = new CompositeAgentJobHost([terminal, shell]);

    await expect(composite.list({
      sessionId: "s1",
      kinds: ["terminal", "shell"],
      includeFinished: false,
      limit: 1,
    })).resolves.toMatchObject([{ id: "shell_1" }]);

    expect(terminal.list).toHaveBeenCalledWith({
      sessionId: "s1",
      kinds: ["terminal", "shell"],
      includeFinished: false,
    });
    expect(shell.list).toHaveBeenCalledWith({
      sessionId: "s1",
      kinds: ["terminal", "shell"],
      includeFinished: false,
    });
  });

  it("routes read to the owner established by list", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);
    await composite.list({ sessionId: "s1" });

    await composite.read({ sessionId: "s1", jobId: "terminal_1", after: 4, maxChars: 20 });

    expect(terminal.read).toHaveBeenCalledWith({
      sessionId: "s1", jobId: "terminal_1", after: 4, maxChars: 20,
    });
    expect(shell.read).not.toHaveBeenCalled();
  });

  it("routes wait to the owner established by list", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);
    await composite.list({ sessionId: "s1" });

    await composite.wait({ sessionId: "s1", jobId: "terminal_1", timeoutMs: 50 });

    expect(terminal.wait).toHaveBeenCalledWith({ sessionId: "s1", jobId: "terminal_1", timeoutMs: 50 });
    expect(shell.wait).not.toHaveBeenCalled();
  });

  it("routes send to the owner established by list", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);
    await composite.list({ sessionId: "s1", includeFinished: true });

    await composite.send({ sessionId: "s1", jobId: "terminal_1", data: "pwd\n" });

    expect(terminal.send).toHaveBeenCalledOnce();
    expect(shell.send).not.toHaveBeenCalled();
  });

  it("routes cancel to the owner established by list", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);
    await composite.list({ sessionId: "s1" });

    await composite.cancel({ sessionId: "s1", jobId: "terminal_1", reason: "done" });

    expect(terminal.cancel).toHaveBeenCalledWith({ sessionId: "s1", jobId: "terminal_1", reason: "done" });
    expect(shell.cancel).not.toHaveBeenCalled();
  });

  it("resolves an unindexed job by listing every source with finished jobs included", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1", { status: "completed" })]);
    const composite = new CompositeAgentJobHost([terminal, shell]);

    await composite.send({ sessionId: "s1", jobId: "shell_1", data: "pwd\n" });

    expect(terminal.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
    expect(shell.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
    expect(shell.send).toHaveBeenCalledOnce();
    expect(terminal.send).not.toHaveBeenCalled();
  });

  it("keeps same job ids in different sessions routed to their respective owners", async () => {
    const terminal = fakeJobHost([job("shared", { ownerSession: "s1" })]);
    const shell = fakeJobHost([job("shared", { ownerSession: "s2" })]);
    const composite = new CompositeAgentJobHost([terminal, shell]);

    await composite.list({ sessionId: "s1" });
    await composite.list({ sessionId: "s2" });
    await composite.send({ sessionId: "s1", jobId: "shared", data: "one" });
    await composite.send({ sessionId: "s2", jobId: "shared", data: "two" });

    expect(terminal.send).toHaveBeenCalledWith({ sessionId: "s1", jobId: "shared", data: "one" });
    expect(shell.send).toHaveBeenCalledWith({ sessionId: "s2", jobId: "shared", data: "two" });
  });

  it("rejects an unindexed missing job after rebuilding the session index", async () => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);

    await expect(composite.read({ sessionId: "s1", jobId: "missing" })).rejects.toThrow(
      "Job not found: missing",
    );
    expect(terminal.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
    expect(shell.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
  });

  it("replaces stale session owners when a cache miss rebuilds the index", async () => {
    const jobs = [job("terminal_1")];
    const terminal = fakeJobHost(jobs);
    const composite = new CompositeAgentJobHost([terminal]);
    await composite.list({ sessionId: "s1" });
    jobs.splice(0);

    await expect(composite.read({ sessionId: "s1", jobId: "missing" })).rejects.toThrow(
      "Job not found: missing",
    );
    await expect(composite.read({ sessionId: "s1", jobId: "terminal_1" })).rejects.toThrow(
      "Job not found: terminal_1",
    );
    expect(terminal.read).not.toHaveBeenCalled();
  });

  it.each([
    ["read", (host: CompositeAgentJobHost) => host.read({ sessionId: "s1", jobId: "terminal_1" })],
    ["wait", (host: CompositeAgentJobHost) => host.wait({ sessionId: "s1", jobId: "terminal_1", timeoutMs: 50 })],
    ["send", (host: CompositeAgentJobHost) => host.send({ sessionId: "s1", jobId: "terminal_1", data: "pwd\\n" })],
    ["cancel", (host: CompositeAgentJobHost) => host.cancel({ sessionId: "s1", jobId: "terminal_1" })],
  ])("propagates a resolved owner error without probing another source for %s", async (_operation, invoke) => {
    const expected = new Error("terminal is unavailable");
    const terminal = fakeJobHost([job("terminal_1")], {
      read: async () => { throw expected; },
      wait: async () => { throw expected; },
      send: async () => { throw expected; },
      cancel: async () => { throw expected; },
    });
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);
    await composite.list({ sessionId: "s1" });

    await expect(invoke(composite)).rejects.toBe(expected);
    expect(shell.read).not.toHaveBeenCalled();
    expect(shell.wait).not.toHaveBeenCalled();
    expect(shell.send).not.toHaveBeenCalled();
    expect(shell.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["read", (host: CompositeAgentJobHost) => host.read({ sessionId: "s1", jobId: "terminal_1" })],
    ["wait", (host: CompositeAgentJobHost) => host.wait({ sessionId: "s1", jobId: "terminal_1", timeoutMs: 50 })],
    ["send", (host: CompositeAgentJobHost) => host.send({ sessionId: "s1", jobId: "terminal_1", data: "pwd\\n" })],
    ["cancel", (host: CompositeAgentJobHost) => host.cancel({ sessionId: "s1", jobId: "terminal_1" })],
  ])("rebuilds the owner for an unindexed job before %s", async (_operation, invoke) => {
    const terminal = fakeJobHost([job("terminal_1")]);
    const shell = fakeJobHost([job("shell_1")]);
    const composite = new CompositeAgentJobHost([terminal, shell]);

    await invoke(composite);

    expect(terminal.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
    expect(shell.list).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true });
  });

  it.each([
    ["read", (host: CompositeAgentJobHost) => host.read({ sessionId: "s1", jobId: "missing" })],
    ["wait", (host: CompositeAgentJobHost) => host.wait({ sessionId: "s1", jobId: "missing", timeoutMs: 50 })],
    ["send", (host: CompositeAgentJobHost) => host.send({ sessionId: "s1", jobId: "missing", data: "pwd\\n" })],
    ["cancel", (host: CompositeAgentJobHost) => host.cancel({ sessionId: "s1", jobId: "missing" })],
  ])("reports a missing job before %s", async (_operation, invoke) => {
    const composite = new CompositeAgentJobHost([fakeJobHost([])]);

    await expect(invoke(composite)).rejects.toThrow("Job not found: missing");
  });
});

function fakeJobHost(
  jobs: JobSnapshot[],
  overrides: Partial<AgentJobHost> = {},
): AgentJobHost & {
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async (input: JobListRequest) => filterJobSnapshots(
    jobs.filter((candidate) => candidate.ownerSession === input.sessionId),
    input,
  ));
  const read = vi.fn(async () => readResult(jobs[0]!));
  const wait = vi.fn(async () => waitResult(jobs[0]!));
  const send = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => jobs[0]!);
  return { list, read, wait, send, cancel, ...overrides } as AgentJobHost & {
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    wait: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

function job(id: string, overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id,
    kind: "terminal",
    label: id,
    ownerSession: "s1",
    status: "running",
    capabilities: { read: true, wait: true, send: true, cancel: true },
    cwd: "/repo",
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function readResult(snapshot: JobSnapshot): JobReadResult {
  return { text: "", cursor: 0, truncated: false, snapshot };
}

function waitResult(snapshot: JobSnapshot): JobWaitResult {
  return { ...readResult(snapshot), timedOut: false };
}
