import { describe, expect, it, vi } from "vitest";

import { createPermissionRoutes } from "./permission.js";
import { createRunExecutionRoutes } from "./run-execution.js";
import { createScheduleRoutes } from "./schedules.js";
import { createSessionRoutes } from "./session.js";

const invalidRequest = (field?: string) => ({
  code: "invalid_request",
  message: expect.any(String),
  ...(field ? { details: { field } } : {}),
});

function sessionRoutes(createSession = vi.fn()) {
  return {
    app: createSessionRoutes({
      queries: {
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
      },
      commands: {
        createSession,
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(),
        deleteSessionTree: vi.fn(),
        forkSession: vi.fn(),
      },
      interactions: { warmSession: vi.fn() },
      traces: { get: vi.fn() },
    }),
    createSession,
  };
}

describe("protocol validation at HTTP routes", () => {
  it("rejects an invalid Session field before calling the application", async () => {
    const { app, createSession } = sessionRoutes();
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", model: "gpt-test", agent: 42 }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest("agent"));
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown Prompt delivery mode before admitting input", async () => {
    const admitPrompt = vi.fn();
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt,
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(),
      },
      traces: { get: vi.fn() },
    });
    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", delivery: "immediate" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest("delivery"));
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array attachments", { attachments: {} }, "attachments"],
    ["an attachment without assetId", { attachments: [{ intent: "auto" }] }, "attachments[0].assetId"],
    ["an unknown attachment intent", { attachments: [{ assetId: "att-1", intent: "scan" }] }, "attachments[0].intent"],
  ])("rejects %s before admitting input", async (_name, invalid, field) => {
    const admitPrompt = vi.fn();
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt,
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(),
      },
      traces: { get: vi.fn() },
    });
    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", ...invalid }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest(field));
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array attachments", { attachments: {} }, "attachments"],
    ["an attachment without assetId", { attachments: [{ intent: "auto" }] }, "attachments[0].assetId"],
    ["an unknown attachment intent", { attachments: [{ assetId: "att-1", intent: "scan" }] }, "attachments[0].intent"],
  ])("rejects %s before editing input", async (_name, invalid, field) => {
    const editLatestPrompt = vi.fn();
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        editLatestPrompt,
        resumeRun: vi.fn(),
        interruptSession: vi.fn(),
      },
      traces: { get: vi.fn() },
    });
    const response = await app.request("/s1/prompts/latest/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "edit-1",
        content: "hello",
        sourceMessageId: "message-1",
        ...invalid,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest(field));
    expect(editLatestPrompt).not.toHaveBeenCalled();
  });

  it("rejects an invalid Permission decision before replying", async () => {
    const reply = vi.fn();
    const app = createPermissionRoutes({
      permissions: { listRequests: vi.fn(() => []), reply },
      traces: { get: vi.fn() },
    });
    const response = await app.request("/p1/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", decision: "forever" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest("decision"));
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects invalid nested Schedule fields before creating a task", async () => {
    const createTask = vi.fn();
    const app = createScheduleRoutes({
      schedules: {
        createTask,
        getTask: vi.fn(),
        listRuns: vi.fn(() => []),
        listTasks: vi.fn(() => []),
        markRunRead: vi.fn(),
        removeTask: vi.fn(),
        status: vi.fn(() => ({
          running: true,
          tasks: 0,
          active: 0,
          paused: 0,
          executing: 0,
          unread: 0,
        })),
        trigger: vi.fn(),
        updateTask: vi.fn(),
      },
    });
    const response = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "review",
        prompt: "Review changes",
        recurrence: "tomorrow",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
        projectPaths: ["/repo", 42],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest("projectPaths"));
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns the same error code for malformed JSON", async () => {
    const { app, createSession } = sessionRoutes();
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidRequest());
    expect(createSession).not.toHaveBeenCalled();
  });
});
