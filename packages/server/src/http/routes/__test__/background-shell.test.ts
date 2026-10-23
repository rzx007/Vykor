import { describe, expect, it, vi } from "vitest";

import { BackgroundShellError } from "../../../application/session/execution/background-shell-service.js";
import { createBackgroundShellRoutes } from "../background-shell.js";

describe("background shell routes", () => {
  it("creates a shell and returns its normalized Job snapshot", async () => {
    const create = vi.fn(async () => ({ execution: { id: "task-1" }, created: true }));
    const read = vi.fn(async () => ({
      text: "",
      cursor: 1,
      truncated: false,
      snapshot: {
        id: "task-1",
        kind: "shell" as const,
        label: "pnpm test",
        ownerSession: "s1",
        status: "running" as const,
        capabilities: { read: true, wait: true, send: false, cancel: true },
        cwd: "/repo",
        startedAt: 1,
        updatedAt: 1,
      },
    }));
    const app = createBackgroundShellRoutes({ backgroundShells: { create, stop: vi.fn() }, jobs: { read } });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "request-1" },
      body: JSON.stringify({ sessionId: "s1", command: "  pnpm test  " }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      requestId: "http:request-1",
      sessionId: "s1",
      cwd: undefined,
      command: "pnpm test",
      description: undefined,
    });
    expect(read).toHaveBeenCalledWith({ sessionId: "s1", jobId: "task-1" });
    await expect(response.json()).resolves.toMatchObject({
      jobId: "task-1",
      snapshot: { id: "task-1", kind: "shell", status: "running" },
    });
  });

  it.each([
    [{ command: "echo hi" }, "sessionId is required"],
    [{ sessionId: "s1", command: "   " }, "command is required"],
  ])("rejects invalid input %#", async (body, message) => {
    const app = createBackgroundShellRoutes({
      backgroundShells: { create: vi.fn(), stop: vi.fn() },
      jobs: { read: vi.fn() },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: message });
  });

  it("preserves a BackgroundShellError status before a shell is created", async () => {
    const app = createBackgroundShellRoutes({
      backgroundShells: {
        create: vi.fn(async () => { throw new BackgroundShellError(404, "Session not found"); }),
        stop: vi.fn(),
      },
      jobs: { read: vi.fn() },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "missing", command: "echo hi" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  it("stops a created shell and returns 500 when Job normalization fails", async () => {
    const stop = vi.fn(async () => ({ execution: { id: "task-1", status: "stopped" } }));
    const app = createBackgroundShellRoutes({
      backgroundShells: {
        create: vi.fn(async () => ({ execution: { id: "task-1" }, created: true })),
        stop,
      },
      jobs: {
        read: vi.fn(async () => { throw new Error("normalization unavailable"); }),
      },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", command: "echo hi" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "normalization unavailable" });
    expect(stop).toHaveBeenCalledWith("task-1", { sessionId: "s1" });
  });
});
