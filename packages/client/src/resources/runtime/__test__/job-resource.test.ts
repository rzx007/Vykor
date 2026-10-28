import { describe, expect, it } from "vitest";

import { JobResource } from "../job-resource.js";

const snapshot = {
  id: "job-1", kind: "shell", target: { kind: "shell", jobId: "job-1" }, label: "tests", ownerSession: "s1",
  status: "failed", capabilities: { read: true, wait: true, send: false, cancel: false },
  cwd: "/repo", startedAt: 1, updatedAt: 2, exitCode: 7,
};

describe("JobResource", () => {
  it("allows input without a framework receipt and rejects an invalid receipt", async () => {
    let response: unknown = { sent: true };
    const jobs = new JobResource({ request: async () => response } as any);
    const target = { kind: "terminal", jobId: "terminal" } as const;
    await expect(jobs.send(target, { sessionId: "s1", data: "input" })).resolves.toBeUndefined();
    response = { sent: true, receipt: { sessionId: "child", inputId: "input" } };
    await expect(jobs.send(target, { sessionId: "s1", data: "input" })).rejects.toThrow();
  });
  it("keeps a server exit code through list, read, wait and cancel decoding", async () => {
    const transport = {
      path: (path: string) => path,
      request: async (path: string) => JSON.parse(JSON.stringify(
        path === "/jobs" ? { jobs: [snapshot], errors: [] }
          : path.endsWith("/wait") ? { text: "", cursor: 0, truncated: false, timedOut: false, snapshot }
          : path.endsWith("/cancel") ? { snapshot }
          : { text: "", cursor: 0, truncated: false, snapshot },
      )),
    };
    const jobs = new JobResource(transport as any);
    expect((await jobs.list({ sessionId: "s1" })).jobs[0]?.exitCode).toBe(7);
    expect((await jobs.read({ kind: "shell", jobId: "job-1" }, { sessionId: "s1" })).snapshot.exitCode).toBe(7);
    expect((await jobs.wait({ kind: "shell", jobId: "job-1" }, { sessionId: "s1" })).snapshot.exitCode).toBe(7);
    expect((await jobs.cancel({ kind: "shell", jobId: "job-1" }, { sessionId: "s1" })).exitCode).toBe(7);
  });
});
