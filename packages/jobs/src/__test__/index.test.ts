import { describe, expect, it } from "vitest";

import { filterJobSnapshots, type JobSnapshot } from "../index.js";

const jobs: JobSnapshot[] = [
  snapshot("terminal-1", "terminal", "running", 30, 40),
  snapshot("agent-1", "agent", "completed", 20, 50),
  snapshot("workflow-1", "workflow", "failed", 10, 60),
];

describe("filterJobSnapshots", () => {
  it("combines kind, status, time, finished, and limit filters", () => {
    expect(filterJobSnapshots(jobs, {
      kinds: ["terminal", "agent"],
      statuses: ["running", "completed"],
      startedAfter: 15,
      updatedBefore: 55,
      includeFinished: true,
      limit: 1,
    }).map((job) => job.id)).toEqual(["terminal-1"]);
  });

  it("keeps all sorted jobs when limit is omitted", () => {
    expect(filterJobSnapshots(jobs, {}).map((job) => job.id)).toEqual([
      "terminal-1",
      "agent-1",
      "workflow-1",
    ]);
  });

  it("treats empty kind and status arrays as no filters", () => {
    expect(filterJobSnapshots(jobs, { kinds: [], statuses: [] }).map((job) => job.id)).toEqual([
      "terminal-1",
      "agent-1",
      "workflow-1",
    ]);
  });

  it("can exclude every terminal state", () => {
    expect(filterJobSnapshots(jobs, { includeFinished: false }).map((job) => job.id))
      .toEqual(["terminal-1"]);
  });
});

function snapshot(
  id: string,
  kind: JobSnapshot["kind"],
  status: JobSnapshot["status"],
  startedAt: number,
  updatedAt: number,
): JobSnapshot {
  return {
    id,
    kind,
    target: kind === "agent" ? { kind, jobId: id, runId: "run" } : { kind, jobId: id },
    label: id,
    ownerSession: "session-1",
    status,
    capabilities: { read: true, wait: true, send: false, cancel: false },
    cwd: "/repo",
    startedAt,
    updatedAt,
  };
}
