import { describe, expect, it, vi } from "vitest";

import { createAuthRoutes } from "../auth.js";
import { HttpEventHub } from "../events.js";
import { createGitRoutes } from "../git.js";
import { createMemoryRoutes } from "../memory.js";
import { createPermissionRoutes } from "../permission.js";
import { createRunExecutionRoutes } from "../run-execution.js";
import { createScheduleRoutes } from "../schedules.js";
import { createServiceRoutes } from "../service.js";
import { createSessionRoutes } from "../session.js";
import { createSessionUtilityRoutes } from "../session-utility.js";
import { createSystemRoutes } from "../system.js";
import { SessionApplicationError } from "../../../application/session/session-application-error.js";

function runtimeSnapshot() {
  return {
    startedAt: 100,
    uptimeMs: 25,
    sessions: { total: 2, byStatus: { active: 2 } },
    runs: { total: 1, byStatus: { completed: 1 } },
    tasks: { total: 0, byStatus: {} },
    permissions: { total: 0, byStatus: {} },
    projectionSettlements: { total: 0, pending: 0, byStatus: {} },
    sseClientCount: 0,
    warmAgentCount: 1,
    coordinator: { activeRunCount: 1, queuedRunCount: 3 },
    metrics: { counters: {}, gauges: {}, histograms: {} },
  };
}

function daemonControl(overrides: Record<string, unknown> = {}) {
  return {
    runtimeSnapshot,
    acquireGlobalMutation: () => ({ release() {} }),
    acquireCwdMutation: () => ({ release() {} }),
    closeAllRuntimes: async () => {},
    closeRuntimesForCwd: async () => {},
    invalidateRuntimes: async () => {},
    runtimeInspectionAvailable: true,
    sessionExists: () => true,
    inspectRuntimeHooks: async () => [],
    inspectRun: () => undefined,
    listProjectionDiagnostics: () => ({
      settlements: [],
      pending: 0,
      diagnosticOk: true,
      includeContent: false,
    }),
    ...overrides,
  };
}

describe("Scheduled task routes", () => {
  it("creates Agent schedules and lists their runs", async () => {
    const task = {
      id: "schedule-1",
      name: "weekday-review",
      prompt: "Review changes",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule" as const,
      timezone: "Asia/Shanghai",
      status: "active" as const,
      destination: "standalone" as const,
      projectPaths: ["/repo"],
      executionMode: "local" as const,
      skillNames: [],
      pluginNames: [],
      permissionProfile: { mode: "workspace_write" as const },
      overlapPolicy: "skip" as const,
      missedRunPolicy: "skip" as const,
      createdBy: "user" as const,
      runCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const createTask = vi.fn(() => task);
    const app = createScheduleRoutes({
      schedules: {
        createTask,
        getTask: vi.fn(() => task),
        listTasks: vi.fn(() => [task]),
        updateTask: vi.fn(() => task),
        removeTask: vi.fn(),
        trigger: vi.fn(),
        listRuns: vi.fn(() => []),
        markRunRead: vi.fn(),
        status: vi.fn(() => ({
          running: true,
          tasks: 1,
          active: 1,
          paused: 0,
          executing: 0,
          unread: 0,
        })),
      },
    });

    const response = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: task.name,
        prompt: task.prompt,
        recurrence: task.recurrence,
        recurrenceFormat: task.recurrenceFormat,
        timezone: task.timezone,
        destination: task.destination,
        projectPaths: task.projectPaths,
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ task });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Review changes" }),
    );
    await expect(
      (await app.request("/runs?taskId=schedule-1&unread=true&limit=5")).json(),
    ).resolves.toEqual({ runs: [] });
  });
});

describe("system routes", () => {
  it("reports execution environments from the daemon settings service", async () => {
    const app = createSystemRoutes({
      control: daemonControl(),
      settingsService: {
        get: () => ({}),
        patch: () => ({ settings: {} }),
        agentEnvironmentCapabilities: async () => ({ native: true, wsl: true }),
      },
    });

    const response = await app.request("/capabilities");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentEnvironments: { native: true, wsl: true },
    });
  });
  it("exposes attachment storage scan and explicit safe maintenance actions", async () => {
    const scanAttachments = vi.fn(async () => ({
      summary: { physicalBytes: 10 },
      issues: [],
    }));
    const repairAttachments = vi.fn(async () => ({ expiredLeases: 1 }));
    const gcAttachments = vi.fn(async () => ({ deletedAssets: 2 }));
    const app = createSystemRoutes({
      control: daemonControl(),
      retention: { scanAttachments, repairAttachments, gcAttachments },
    });

    const scan = await app.request("/attachments/storage");
    expect(scan.status).toBe(200);
    await expect(scan.json()).resolves.toMatchObject({
      summary: { physicalBytes: 10 },
    });

    const repaired = await app.request("/attachments/storage/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "repair-safe" }),
    });
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toEqual({ expiredLeases: 1 });

    const collected = await app.request("/attachments/storage/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "gc" }),
    });
    expect(collected.status).toBe(200);
    await expect(collected.json()).resolves.toEqual({ deletedAssets: 2 });
    expect(scanAttachments).toHaveBeenCalledOnce();
    expect(repairAttachments).toHaveBeenCalledOnce();
    expect(gcAttachments).toHaveBeenCalledOnce();
  });

  it("serves health from the runtime snapshot", async () => {
    const app = createSystemRoutes({
      version: "1.2.3",
      control: daemonControl(),
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      version: "1.2.3",
      sessionCount: 2,
      activeRunCount: 1,
      queuedRunCount: 3,
    });
  });

  it("lists built-in and provider commands", async () => {
    const app = createSystemRoutes({
      control: daemonControl(),
      commandCatalog: {
        list: () => [{ name: "/custom", kind: "template", source: "project" }],
      },
    });

    const response = await app.request("/commands?cwd=/repo");
    const body = (await response.json()) as {
      commands: Array<{ name: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.commands.some((command) => command.name === "/custom")).toBe(
      true,
    );
    expect(body.commands.some((command) => command.name === "/model")).toBe(
      false,
    );
  });

  it("allows soft settings updates while session runs are active", async () => {
    const patch = vi.fn(async () => ({
      settings: { workStyle: "efficient" },
      invalidateRuntimes: true,
    }));
    const invalidateRuntimes = vi.fn(async () => {});
    const app = createSystemRoutes({
      settingsService: {
        get: async () => ({ workStyle: "practical" }),
        patch,
      },
      control: daemonControl({
        acquireGlobalMutation: () => undefined,
        invalidateRuntimes,
      }),
    });

    const response = await app.request("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workStyle: "efficient" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settings: { workStyle: "efficient" },
    });
    expect(patch).toHaveBeenCalledWith({ workStyle: "efficient" });
    expect(invalidateRuntimes).toHaveBeenCalledOnce();
  });

  it("still blocks hard settings updates while session runs are active", async () => {
    const patch = vi.fn(async () => ({
      settings: { provider: "anthropic" },
      restartRuntimes: true,
    }));
    const app = createSystemRoutes({
      settingsService: {
        get: async () => ({ provider: "openai" }),
        patch,
      },
      control: daemonControl({ acquireGlobalMutation: () => undefined }),
    });

    const response = await app.request("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot update daemon settings while session runs are active",
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("lists connected model providers", async () => {
    const app = createSystemRoutes({
      control: daemonControl(),
      modelService: {
        list: () => [
          {
            name: "deepseek",
            displayName: "DeepSeek",
            models: [
              {
                id: "deepseek-chat",
                label: "DeepSeek Chat",
                provider: "DeepSeek",
                providerName: "deepseek",
              },
            ],
          },
        ],
      },
    });

    const response = await app.request("/models");
    const body = (await response.json()) as {
      providers: Array<{ name: string; models: Array<{ id: string }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.providers).toEqual([
      {
        name: "deepseek",
        displayName: "DeepSeek",
        models: [
          {
            id: "deepseek-chat",
            label: "DeepSeek Chat",
            provider: "DeepSeek",
            providerName: "deepseek",
          },
        ],
      },
    ]);
  });
});

describe("memory routes", () => {
  it("adds memory and closes runtimes for the cwd", async () => {
    const closeRuntimesForCwd = vi.fn();
    const app = createMemoryRoutes({
      memoryService: {
        add: async (input) => ({ id: "m1", ...input }),
        list: async () => ({ entries: [] }),
        get: async () => undefined,
        remove: async () => false,
      },
      control: daemonControl({ closeRuntimesForCwd }),
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/repo",
        content: "Remember this",
        tags: ["a"],
      }),
    });

    expect(response.status).toBe(201);
    expect(closeRuntimesForCwd).toHaveBeenCalledWith("/repo");
  });
});

describe("auth routes", () => {
  it("rejects login while runs are active", async () => {
    const app = createAuthRoutes({
      authService: {
        status: async () => ({ providers: [] }),
        login: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
      },
      control: daemonControl({ acquireGlobalMutation: () => undefined }),
    });

    const response = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot update authentication while session runs are active",
    });
  });
});

describe("service routes", () => {
  it("serves context status", async () => {
    const app = createServiceRoutes({
      contextService: {
        preview: async () => ({ report: "preview" }),
        status: async () => ({ report: "status table" }),
      },
      control: daemonControl(),
    });

    const response = await app.request("/context/status?cwd=/repo");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: "status table" });
  });

  it("blocks plugin reload while runs are active for the cwd", async () => {
    const app = createServiceRoutes({
      pluginService: {
        list: async () => ({ plugins: [], warnings: [] }),
        setEnabled: async () => ({ message: "ok" }),
      },
      control: daemonControl({ acquireCwdMutation: () => undefined }),
    });

    const response = await app.request("/plugins/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/repo" }),
    });

    expect(response.status).toBe(409);
  });
});

describe("git routes", () => {
  it("requires cwd for git status", async () => {
    const app = createGitRoutes({
      gitService: {
        diff: async () => ({ output: "" }),
        branch: async () => ({ output: "" }),
        status: async () => ({ output: "" }),
        commit: async () => ({ output: "" }),
      },
    });

    const response = await app.request("/status");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "cwd is required",
    });
  });
});

describe("permission routes", () => {
  it("passes trace id through permission replies", async () => {
    const reply = vi.fn(() => ({ id: "p1", status: "approved" }));
    const app = createPermissionRoutes({
      permissions: { listRequests: () => [], reply },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/p1/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "approved",
        decision: "once",
        clientId: "desk",
      }),
    });

    expect(response.status).toBe(200);
    expect(reply).toHaveBeenCalledWith({
      requestId: "p1",
      traceId: "trace-1",
      status: "approved",
      decision: "once",
      clientId: "desk",
    });
  });
});

describe("session routes", () => {
  it("creates sessions and warms their runtime", async () => {
    const session = {
      id: "s1",
      cwd: "/repo",
      title: "New session",
      model: "gpt-test",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const createSession = vi.fn(() => session);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
      },
      application: {
        createSession,
        getSession: vi.fn(),
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(async () => session),
        deleteSessionTree: vi.fn(),
        forkSession: vi.fn(),
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s1", cwd: "/repo", model: "gpt-test" }),
    });

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", cwd: "/repo" }),
    );
  });

  it("forks a session after a selected message", async () => {
    const fork = {
      id: "fork-1",
      parentId: "s1",
      cwd: "/repo",
      title: "Session fork",
      model: "gpt-test",
      status: "idle",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const forkSession = vi.fn(() => fork);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
      },
      application: {
        createSession: vi.fn(),
        getSession: vi.fn(),
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(),
        deleteSessionTree: vi.fn(),
        forkSession,
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterMessageId: "m2" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ session: fork });
    expect(forkSession).toHaveBeenCalledWith("s1", {
      afterMessageId: "m2",
    });
  });

  it("hard deletes a session through the explicit hard-delete route", async () => {
    const deleteSessionTree = vi.fn(async () => ["child", "parent"]);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
      },
      application: {
        createSession: vi.fn(),
        getSession: vi.fn(),
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(),
        deleteSessionTree,
        forkSession: vi.fn(),
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/parent/hard", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deletedSessionIds: ["child", "parent"],
    });
    expect(deleteSessionTree).toHaveBeenCalledWith("parent");
  });
});

describe("run execution routes", () => {
  it("promotes and cancels one exact queued prompt", async () => {
    const promoteQueuedPrompt = vi.fn(() => ({
      input: { id: "input-queued" },
      queued_run: { id: "run-queued", status: "interrupted" },
      active_run: { id: "run-active", status: "running" },
    }));
    const cancelQueuedPrompt = vi.fn(() => ({
      input: { id: "input-other" },
      run: { id: "run-other", status: "interrupted" },
    }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        cancelQueuedPrompt,
        editLatestPrompt: vi.fn(),
        interruptSession: vi.fn(),
        promoteQueuedPrompt,
        resumeRun: vi.fn(),
      },
      traces: { get: () => "trace-queue-action" },
    });

    const promoted = await app.request("/s1/prompts/input-queued/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queuedRunId: "run-queued",
        expectedActiveRunId: "run-active",
      }),
    });
    const cancelled = await app.request("/s1/prompts/input-other/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queuedRunId: "run-other" }),
    });

    expect(promoted.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(promoteQueuedPrompt).toHaveBeenCalledWith("s1", "input-queued", {
      queuedRunId: "run-queued",
      expectedActiveRunId: "run-active",
    });
    expect(cancelQueuedPrompt).toHaveBeenCalledWith("s1", "input-other", {
      queuedRunId: "run-other",
    });
  });

  it("requires and forwards the exact message selected for prompt editing", async () => {
    const editLatestPrompt = vi.fn(() => ({ input: { id: "edited-input" } }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        editLatestPrompt,
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-edit" },
    });

    const missingSource = await app.request("/s1/prompts/latest/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "edit-1", content: "replacement" }),
    });
    expect(missingSource.status).toBe(400);
    expect(editLatestPrompt).not.toHaveBeenCalled();

    const response = await app.request("/s1/prompts/latest/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "edit-1",
        content: "replacement",
        sourceMessageId: "message-1",
        attachments: [
          { assetId: "att-b", intent: "auto" },
          { assetId: "att-a", intent: "ocr", displayName: "receipt.png" },
        ],
      }),
    });

    expect(response.status).toBe(202);
    expect(editLatestPrompt).toHaveBeenCalledWith("s1", {
      id: "edit-1",
      items: [{ type: "text", text: "replacement" }],
      sourceMessageId: "message-1",
      attachments: [
        { assetId: "att-b", intent: "auto" },
        { assetId: "att-a", intent: "ocr", displayName: "receipt.png" },
      ],
      traceId: "trace-edit",
    });
  });

  it("scopes an interrupt to the run that was visible when stop was clicked", async () => {
    const interruptSession = vi.fn(() => ({
      interrupted: true,
      queuedRunIds: [],
    }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession,
      },
      traces: { get: () => "trace-stop" },
    });

    const response = await app.request("/s1/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRunId: "run-before-click" }),
    });

    expect(response.status).toBe(200);
    expect(interruptSession).toHaveBeenCalledWith("s1", "run-before-click");
  });

  it("rejects a malformed scoped interrupt instead of falling back to interrupt-all", async () => {
    const interruptSession = vi.fn();
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession,
      },
      traces: { get: () => "trace-stop" },
    });

    const response = await app.request("/s1/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRunId: 123 }),
    });

    expect(response.status).toBe(400);
    expect(interruptSession).not.toHaveBeenCalled();
  });

  it("admits prompts with trace metadata", async () => {
    const admitPromptAndMaybeRun = vi.fn(() => ({
      input: {
        id: "i1",
        sessionId: "s1",
        seq: 1,
        delivery: "steer",
        content: "hello",
        metadata: {},
        createdAt: 1,
      },
    }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: admitPromptAndMaybeRun,
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "i1",
        delivery: "steer",
        content: "hello",
        attachments: [
          { assetId: "att-b", intent: "auto" },
          { assetId: "att-a", intent: "ocr", displayName: "receipt.png" },
        ],
        metadata: { source: "test" },
      }),
    });

    expect(response.status).toBe(202);
    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "i1",
      delivery: "steer",
      items: [{ type: "text", text: "hello" }],
      attachments: [
        { assetId: "att-b", intent: "auto" },
        { assetId: "att-a", intent: "ocr", displayName: "receipt.png" },
      ],
      metadata: { source: "test" },
      traceId: "trace-1",
    });
  });

  it("preserves session application error status for prompt failures", async () => {
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(async () => {
          throw new SessionApplicationError(500, "projection mismatch");
        }),
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(response.status).toBe(500);
  });

  it("forwards interrupted-run recovery to the session application", async () => {
    const resumeRun = vi.fn(() => ({
      input: { id: "recovery-input" },
      run: { id: "recovery-run" },
      source_run: { id: "source-run", status: "interrupted" },
    }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        editLatestPrompt: vi.fn(),
        resumeRun,
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/runs/source-run/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "recovery-input",
        metadata: { requestedBy: "test" },
      }),
    });

    expect(response.status).toBe(202);
    expect(resumeRun).toHaveBeenCalledWith("s1", "source-run", {
      id: "recovery-input",
      metadata: { requestedBy: "test" },
      traceId: "trace-1",
    });
  });
});

describe("session utility routes", () => {
  it("forwards rewind parameters to session maintenance", async () => {
    const rewind = vi.fn(async () => ({
      turns: 2,
      removed: 4,
      messages: [],
      parts: [],
    }));
    const app = createSessionUtilityRoutes({
      maintenance: {
        listMcpServers: vi.fn(),
        getUsage: vi.fn(),
        exportSession: vi.fn(),
        compact: vi.fn(),
        rewind,
        remember: vi.fn(),
      },
    });

    const response = await app.request("/s1/rewind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });

    expect(response.status).toBe(200);
    expect(rewind).toHaveBeenCalledWith("s1", 2);
  });
});

describe("event routes", () => {
  it("lists events with cursor, session, and limit filters", async () => {
    const listEvents = vi.fn(() => [
      {
        id: "e1",
        seq: 2,
        type: "session.updated",
        sessionId: "s1",
        payload: {},
        createdAt: 1,
      },
    ]);
    const hub = new HttpEventHub({ list: listEvents } as any);

    const response = await hub
      .createRoutes()
      .request("/?cursor=1&sessionId=s1&limit=5");

    expect(response.status).toBe(200);
    expect(listEvents).toHaveBeenCalledWith({
      afterSeq: 1,
      sessionId: "s1",
      limit: 5,
    });
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          id: "e1",
          seq: 2,
          type: "session.updated",
          sessionId: "s1",
          payload: {},
          createdAt: 1,
        },
      ],
    });
  });
});
