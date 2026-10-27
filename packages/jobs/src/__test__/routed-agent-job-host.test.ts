import { describe, expect, it, vi } from "vitest";
import { RoutedAgentJobHost, filterJobSnapshots, type AgentJobHost, type JobSnapshot } from "../index.js";

describe("RoutedAgentJobHost", () => {
  it("never lists to read, wait, send or cancel a target", async () => {
    const target = { kind: "agent", jobId: "a", runId: "r" } as const;
    const snapshot: JobSnapshot = { id: "a", kind: "agent", target, label: "a", ownerSession: "s", status: "completed", capabilities: { read: true, wait: true, send: true, cancel: false }, cwd: "/repo", startedAt: 1, updatedAt: 2 };
    const list = vi.fn(async () => { throw new Error("listing failed"); });
    const source: AgentJobHost = { list, read: async () => ({ snapshot, text: "done", cursor: 4, truncated: false }), wait: async () => ({ snapshot, text: "done", cursor: 4, truncated: false, timedOut: false }), send: async () => ({ sessionId: "child", inputId: "i", runId: "r2" }), cancel: async () => snapshot };
    const jobs = new RoutedAgentJobHost({ agent: source, shell: source });
    const request = { sessionId: "s", target };
    expect((await jobs.read(request)).text).toBe("done");
    expect((await jobs.wait({ ...request, timeoutMs: 1 })).timedOut).toBe(false);
    expect((await jobs.send({ ...request, data: "next" }))?.runId).toBe("r2");
    expect((await jobs.cancel(request)).status).toBe("completed");
    expect(list).not.toHaveBeenCalled();
    expect((await jobs.list({ sessionId: "s" })).errors).toHaveLength(2);
    await expect(jobs.read({ sessionId: "s", target: { kind: "terminal", jobId: "t" } })).rejects.toThrow(/not supported/);
  });

  it("lists each bound kind separately and applies global sorting and limit", async () => {
    const list = vi.fn(async (input) => ({ jobs: [{ id: input.kinds[0], kind: input.kinds[0], target: { kind: input.kinds[0], jobId: input.kinds[0] }, label: "job", ownerSession: "s", status: "running", capabilities: { read: true, wait: true, send: false, cancel: true }, cwd: "/", startedAt: input.kinds[0] === "shell" ? 2 : 1, updatedAt: 2 }], errors: [] }));
    const source = { list } as unknown as AgentJobHost;
    const jobs = new RoutedAgentJobHost({ shell: source, terminal: source });
    expect((await jobs.list({ sessionId: "s", limit: 1 })).jobs.map(job => job.id)).toEqual(["shell"]);
    expect(list.mock.calls.map(([input]) => input.kinds)).toEqual([["shell"], ["terminal"]]);
  });
});


it("preserves portable filters after merging fixed sources", async () => {
  const snapshots = [
    { id: "old", kind: "shell", target: { kind: "shell", jobId: "old" }, status: "completed", startedAt: 10, updatedAt: 20 },
    { id: "new", kind: "terminal", target: { kind: "terminal", jobId: "new" }, status: "running", startedAt: 30, updatedAt: 40 },
  ].map(job => ({ ...job, label: job.id, ownerSession: "s", cwd: "/", capabilities: { read: true, wait: true, send: false, cancel: true } })) as JobSnapshot[];
  const source = { list: async input => ({ jobs: filterJobSnapshots(snapshots, input), errors: [] }) } as AgentJobHost;
  const jobs = new RoutedAgentJobHost({ shell: source, terminal: source });
  expect((await jobs.list({ sessionId: "s", includeFinished: false })).jobs.map(job => job.id)).toEqual(["new"]);
  expect((await jobs.list({ sessionId: "s", kinds: ["shell"], statuses: ["completed"], startedAfter: 5, startedBefore: 15, updatedAfter: 15, updatedBefore: 25 })).jobs.map(job => job.id)).toEqual(["old"]);
  expect((await jobs.list({ sessionId: "s", statuses: ["failed"] })).jobs).toEqual([]);
  await expect(jobs.list({ sessionId: "s", limit: 0 })).rejects.toThrow(/positive integer/);
  await expect(jobs.list({ sessionId: "s", startedAfter: Infinity })).rejects.toThrow(/finite timestamp/);
});
