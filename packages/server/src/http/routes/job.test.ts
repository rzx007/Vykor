import type { JobSnapshot } from "@vykor/jobs";
import { describe, expect, it, vi } from "vitest";

import { createJobRoutes } from "./job.js";

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

describe("Job routes", () => {
  it("requires and forwards the owner session when listing", async () => {
    const list = vi.fn(async () => [{ ...snapshot, status: "failed" as const, exitCode: 7 }]);
    const app = createJobRoutes({ list } as any);

    const response = await app.request(
      "/?sessionId=session-1&kinds=terminal%2Cagent&statuses=running&includeFinished=false&startedAfter=10&limit=5",
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      sessionId: "session-1",
      kinds: ["terminal", "agent"],
      statuses: ["running"],
      includeFinished: false,
      startedAfter: 10,
      limit: 5,
    });
    await expect(response.json()).resolves.toMatchObject({ jobs: [{ id: "terminal-1", exitCode: 7 }] });
  });

  it("rejects unsupported list filters", async () => {
    const app = createJobRoutes({ list: vi.fn() } as any);

    const response = await app.request("/?sessionId=session-1&kinds=cron");

    expect(response.status).toBe(400);
  });

  it("keeps wait bounded in the request contract", async () => {
    const wait = vi.fn(async () => ({ text: "", cursor: 2, truncated: false, snapshot, timedOut: true }));
    const app = createJobRoutes({ wait } as any);

    const response = await app.request("/terminal-1/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", timeoutMs: 250, after: 1 }),
    });

    expect(response.status).toBe(200);
    expect(wait).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      timeoutMs: 250,
      after: 1,
      maxChars: undefined,
      signal: expect.any(AbortSignal),
    });
  });
});
