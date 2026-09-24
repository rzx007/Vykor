import { describe, expect, it } from "vitest";

import { JobResource } from "./job-resource.js";

const snapshot = {
  id: "job-1", kind: "shell", label: "tests", ownerSession: "s1",
  status: "failed", capabilities: { read: true, wait: true, send: false, cancel: false },
  cwd: "/repo", startedAt: 1, updatedAt: 2, exitCode: 7,
};

describe("JobResource", () => {
  it("keeps a server exit code through list, read, wait and cancel decoding", async () => {
    const transport = {
      path: (path: string) => path,
      request: async (path: string) => JSON.parse(JSON.stringify(
        path === "/jobs" ? { jobs: [snapshot] }
          : path.endsWith("/wait") ? { text: "", cursor: 0, truncated: false, timedOut: false, snapshot }
          : path.endsWith("/cancel") ? { snapshot }
          : { text: "", cursor: 0, truncated: false, snapshot },
      )),
    };
    const jobs = new JobResource(transport as any);
    expect((await jobs.list({ sessionId: "s1" }))[0]?.exitCode).toBe(7);
    expect((await jobs.read("job-1", { sessionId: "s1" })).snapshot.exitCode).toBe(7);
    expect((await jobs.wait("job-1", { sessionId: "s1" })).snapshot.exitCode).toBe(7);
    expect((await jobs.cancel("job-1", { sessionId: "s1" })).exitCode).toBe(7);
  });
});
