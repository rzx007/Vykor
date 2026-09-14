import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@openharness/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledTaskService,
  type ScheduleOperations,
} from "../scheduled-task-service.js";
import { DaemonApplication } from "../../application/daemon-application.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.useRealTimers();
});

function createHarness(
  execute = vi.fn(async () => ({
    sessionId: "scheduled-session",
    runId: "agent-run",
    summary: "Agent completed the scheduled work.",
  })),
) {
  const dir = mkdtempSync(join(tmpdir(), "ohs-scheduled-service-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  const service = new ScheduledTaskService({ schedules: store.schedules, execute });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { execute, service, store };
}

describe("ScheduledTaskService", () => {
  it("is composed with store.schedules instead of legacy Store methods", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-schedule-composition-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const application = new DaemonApplication({
      store,
      settings: {
        apiFormat: "anthropic",
        model: "test-model",
        maxTurns: 1,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      log: () => undefined,
    });
    try {
      (store as any).listScheduledTasks = () => {
        throw new Error("legacy method must not be used");
      };
      expect(application.schedules.listTasks()).toEqual([]);
    } finally {
      await application.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupts active runs before reading tasks during startup", async () => {
    const calls: string[] = [];
    const schedules: ScheduleOperations = {
      interruptActiveRuns: (reason) => {
        calls.push(`interrupt:${reason}`);
        return 0;
      },
      listTasks: () => {
        calls.push("listTasks");
        return [];
      },
      listRuns: () => [],
      getTask: () => undefined,
      createTask: () => { throw new Error("unused"); },
      updateTask: () => { throw new Error("unused"); },
      deleteTask: () => false,
      createRun: () => { throw new Error("unused"); },
      updateRun: () => { throw new Error("unused"); },
    };
    const service = new ScheduledTaskService({
      schedules,
      execute: async () => { throw new Error("unused"); },
    });
    cleanups.push(() => service.shutdown());

    expect(calls).toEqual([
      "interrupt:Daemon restarted while the scheduled task was running",
      "listTasks",
    ]);
  });

  it("runs a saved Agent prompt and projects its Session run result", async () => {
    const { execute, service, store } = createHarness();
    const task = service.createTask({
      name: "deployment-follow-up",
      prompt: "Check the deployment and report the result.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      createdBy: "agent",
      createdFromSessionId: "chat-1",
    });

    const run = await service.trigger(task.id);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        prompt: expect.stringContaining("deployment"),
      }),
      expect.objectContaining({ taskId: task.id, cause: "manual" }),
    );
    expect(run).toMatchObject({
      status: "succeeded",
      sessionId: "scheduled-session",
      runId: "agent-run",
      unread: true,
    });
    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "completed",
      runCount: 1,
    });
  });

  it("preserves worktree intent without silently changing it to local execution", () => {
    const { service } = createHarness();
    const task = service.createTask({
      name: "isolated-review",
      prompt: "Review the repository.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "standalone",
      projectPaths: [process.cwd()],
      executionMode: "worktree",
    });

    expect(task.executionMode).toBe("worktree");
    expect(() =>
      service.createTask({
        name: "invalid-chat-worktree",
        prompt: "Review the repository.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "chat",
        sessionId: "chat-1",
        executionMode: "worktree",
      }),
    ).toThrow(/standalone destination/);
    expect(() =>
      service.createTask({
        name: "invalid-outside-worktree",
        prompt: "Review without a project.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
        projectPaths: [],
        executionMode: "worktree",
      }),
    ).toThrow(/at least one project path/);
    expect(() =>
      service.createTask({
        name: "invalid-chat-policy",
        prompt: "Review without writes.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "chat",
        sessionId: "chat-1",
        permissionProfile: { mode: "read_only" },
      }),
    ).toThrow(/inherit their conversation runtime/);
  });

  it("accepts standalone tasks without a project for outside-project runs", () => {
    const { service } = createHarness();
    const task = service.createTask({
      name: "outside-project-briefing",
      prompt: "Summarize today's general priorities.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "Asia/Shanghai",
      destination: "standalone",
      projectPaths: [],
      executionMode: "local",
      model: "gpt-test",
    });

    expect(task).toMatchObject({ destination: "standalone", projectPaths: [] });
    expect(() =>
      service.updateTask(task.id, {
        destination: "chat",
        sessionId: "chat-1",
        model: "",
        effort: "",
        permissionProfile: { mode: "workspace_write" },
      }),
    ).not.toThrow();
  });

  it("runs one missed occurrence after daemon recovery when requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T09:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "ohs-scheduled-recovery-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    store.createScheduledTask({
      id: "missed-task",
      name: "missed-review",
      prompt: "Review the missed interval.",
      recurrence: "2026-08-18T08:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      missedRunPolicy: "run_once",
      nextRunAt: Date.parse("2026-08-18T08:00:00Z"),
    });
    const execute = vi.fn(async () => ({
      sessionId: "chat-1",
      runId: "recovered-run",
      summary: "Recovered missed run.",
    }));
    const service = new ScheduledTaskService({ schedules: store.schedules, execute });
    cleanups.push(async () => {
      await service.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    await vi.runAllTimersAsync();

    expect(execute).toHaveBeenCalledOnce();
    expect(store.getScheduledTask("missed-task")).toMatchObject({
      status: "completed",
      runCount: 1,
    });
  });

  it("completes a recurring task after a successful run when requested", async () => {
    const { service, store } = createHarness();
    const task = service.createTask({
      name: "finish-on-success",
      prompt: "Complete the recurring objective.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      stopPolicy: { stopWhenCompleted: true },
    });

    await service.trigger(task.id);

    const completed = store.getScheduledTask(task.id);
    expect(completed).toMatchObject({
      status: "completed",
      runCount: 1,
    });
    expect(completed?.nextRunAt).toBeUndefined();
  });

  it("does not create skipped runs when a task is updated during an active run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return {
        sessionId: "chat-1",
        runId: "slow-run",
        summary: "Still running.",
      };
    });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "live-update",
      prompt: "Original prompt.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });
    store.updateScheduledTask(task.id, {
      nextRunAt: Date.parse("2026-08-20T09:00:00Z"),
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    service.updateTask(task.id, { prompt: "Updated during the run." });
    await vi.runOnlyPendingTimersAsync();

    release();
    await running;

    expect(
      store
        .listScheduledRuns({ taskId: task.id })
        .filter((run) => run.status === "skipped"),
    ).toHaveLength(0);
  });

  it("does not start a queued run after the task is paused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return {
          sessionId: "chat-1",
          runId: "active-run",
          summary: "Active run finished.",
        };
      })
      .mockResolvedValue({
        sessionId: "chat-1",
        runId: "queued-run",
        summary: "Queued run finished.",
      });
    const { service } = createHarness(execute);
    const task = service.createTask({
      name: "pause-queued-run",
      prompt: "Do not start after pause.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      overlapPolicy: "queue",
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    const queued = service.trigger(task.id);
    service.updateTask(task.id, { status: "paused" });
    release();

    await running;
    const queuedRun = await queued;

    expect(execute).toHaveBeenCalledOnce();
    expect(queuedRun.status).toBe("skipped");
  });

  it("does not start a queued run while the service is shutting down", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return {
          sessionId: "chat-1",
          runId: "active-run",
          summary: "Active run finished.",
        };
      })
      .mockResolvedValue({
        sessionId: "chat-1",
        runId: "queued-run",
        summary: "Queued run finished.",
      });
    const { service } = createHarness(execute);
    const task = service.createTask({
      name: "shutdown-queued-run",
      prompt: "Do not start during shutdown.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      overlapPolicy: "queue",
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    const queued = service.trigger(task.id);
    const shuttingDown = service.shutdown();
    release();

    await running;
    await shuttingDown;
    const queuedRun = await queued;

    expect(execute).toHaveBeenCalledOnce();
    expect(queuedRun.status).toBe("skipped");
    expect(service.status().executing).toBe(0);
  });

  it("reinstalls an edited recurrence after a manual run finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return {
          sessionId: "chat-1",
          runId: "manual-run",
          summary: "Manual run finished.",
        };
      })
      .mockResolvedValue({
        sessionId: "chat-1",
        runId: "scheduled-run",
        summary: "Scheduled run finished.",
      });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "once-to-rrule",
      prompt: "Become recurring while running.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    service.updateTask(task.id, {
      recurrence: "RRULE:FREQ=MINUTELY",
      recurrenceFormat: "rrule",
    });
    release();
    await running;

    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "active",
      recurrenceFormat: "rrule",
      runCount: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "active",
      runCount: 2,
    });
  });

  it("keeps a task paused when its active run finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return {
        sessionId: "chat-1",
        runId: "paused-run",
        summary: "Run finished after pause.",
      };
    });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "pause-during-run",
      prompt: "Pause while this runs.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    service.updateTask(task.id, { status: "paused" });
    release();
    await running;

    const paused = store.getScheduledTask(task.id);
    expect(paused).toMatchObject({
      status: "paused",
      runCount: 1,
    });
    expect(paused?.nextRunAt).toBeUndefined();
  });

  it("completes an exhausted RRULE after its final scheduled timer fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const execute = vi.fn(async () => {
      markExecutionStarted();
      return {
        sessionId: "chat-1",
        runId: "final-run",
        summary: "Last occurrence finished.",
      };
    });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "until-exhausted",
      prompt: "Run the final occurrence.",
      recurrence: "RRULE:FREQ=MINUTELY;UNTIL=20260820T120100Z",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await executionStarted;
    await Promise.resolve();

    expect(execute).toHaveBeenCalledOnce();
    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "completed",
      runCount: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("allows updating a completed task and triggering it manually", async () => {
    const { service, store } = createHarness();
    const task = service.createTask({
      name: "completed-one-time",
      prompt: "One-time run prompt.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });

    await service.trigger(task.id);
    expect(store.getScheduledTask(task.id)?.status).toBe("completed");

    // Simulate that the one-time date has passed into history
    store.updateScheduledTask(task.id, {
      recurrence: "2020-01-01T00:00:00Z",
    });

    // Updating non-schedule fields should succeed without "One-time schedule is not in the future"
    expect(() => {
      service.updateTask(task.id, { prompt: "Updated prompt for completed task" });
    }).not.toThrow();

    expect(store.getScheduledTask(task.id)?.prompt).toBe("Updated prompt for completed task");

    // Manually triggering a completed task should also succeed
    const run = await service.trigger(task.id);
    expect(run.status).toBe("succeeded");
    expect(store.getScheduledTask(task.id)?.status).toBe("completed");
  });
});

