import type { AgentScheduleEffects, ToolContext } from "@vykor/core";
import { describe, expect, it, vi } from "vitest";

import { scheduleCreateTool } from "../scheduled-task-tools.js";

function context(schedules: AgentScheduleEffects): ToolContext {
  return {
    cwd: "/repo",
    sessionId: "chat-1",
    schedules,
    agent: {
      effects: { requestPermission: vi.fn() },
    } as ToolContext["agent"],
  };
}

describe("Agent Scheduled task tools", () => {
  it("binds chat schedules to the current durable session", async () => {
    const create = vi.fn(async (input) => ({
      id: "schedule-1",
      ...input,
      status: "active" as const,
      runCount: 0,
      nextRunAt: Date.parse("2099-01-01T00:00:00Z"),
    }));
    const schedules: AgentScheduleEffects = {
      create,
      update: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(async () => []),
      trigger: vi.fn(),
      listRuns: vi.fn(async () => []),
    };

    const result = await scheduleCreateTool.execute(
      {
        name: "follow-up",
        prompt: "Check deployment status.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "chat",
        projectPaths: ["/model-supplied-project"],
        model: "model-supplied-current-model",
        effort: "high",
        permissionProfile: {
          mode: "workspace_write",
          network: true,
        },
        skillNames: ["review"],
        pluginNames: ["github"],
      },
      context(schedules),
    );

    expect(result.isError).toBeUndefined();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "chat",
        sessionId: "chat-1",
        projectPaths: [],
        prompt: "Check deployment status.",
      }),
    );
    const createdInput = create.mock.calls[0]![0];
    expect(createdInput).not.toHaveProperty("model");
    expect(createdInput).not.toHaveProperty("effort");
    expect(createdInput).not.toHaveProperty("permissionProfile");
    expect(createdInput).toMatchObject({
      skillNames: ["review"],
      pluginNames: ["github"],
    });
  });

  it("forwards isolated execution and permission policy without widening it", async () => {
    const create = vi.fn(async (input) => ({
      id: "schedule-2",
      ...input,
      status: "active" as const,
      runCount: 0,
    }));
    const schedules: AgentScheduleEffects = {
      create,
      update: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(async () => []),
      trigger: vi.fn(),
      listRuns: vi.fn(async () => []),
    };

    await scheduleCreateTool.execute(
      {
        name: "isolated-review",
        prompt: "Review the repository.",
        recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
        recurrenceFormat: "rrule",
        timezone: "Asia/Shanghai",
        destination: "standalone",
        executionMode: "worktree",
        permissionProfile: {
          mode: "read_only",
          network: false,
          deniedTools: ["Bash"],
        },
        overlapPolicy: "queue",
        missedRunPolicy: "run_once",
      },
      context(schedules),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "standalone",
        projectPaths: ["/repo"],
        executionMode: "worktree",
        permissionProfile: {
          mode: "read_only",
          network: false,
          deniedTools: ["Bash"],
        },
        overlapPolicy: "queue",
        missedRunPolicy: "run_once",
      }),
    );
  });
});
