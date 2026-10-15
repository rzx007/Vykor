import { describe, expect, it } from "vitest";
import { createGoalReadTool } from "./goal-read-tool.js";
import { createGoalRunContribution } from "./goal-extension.js";

describe("GoalRead", () => {
  it("reports an expired host binding without replacing it with model IDs", async () => {
    let reads = 0;
    const tool = createGoalReadTool(async () => { reads++; throw new Error("goal_run_stale"); });
    const result = await tool.execute({}, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("goal_run_stale") });
    await tool.execute({ objectiveVersion: 2 }, { cwd: process.cwd() });
    expect(reads).toBe(1);
  });

  it.each(["goalId", "objectiveVersion"])("rechecks %s on every call", async changed => {
    let stale = false;
    const contribution = await createGoalRunContribution({ goalId: "g", objectiveVersion: 1,
      readSnapshot: async () => ({ goalId: stale && changed === "goalId" ? "other" : "g",
        objectiveVersion: stale && changed === "objectiveVersion" ? 2 : 1, status: "active", objective: "work",
        autoTurnsUsed: 0, maxAutoTurns: 0, knownTokens: 0, usageIncomplete: false }),
      submitUpdate: async () => ({ recorded: true }),
    });
    stale = true;
    const read = contribution.tools!.find(item => item.definition.name === "GoalRead")!.definition;
    expect((await read.execute({}, { cwd: process.cwd() })).isError).toBe(true);
  });

  it("returns only the current goal, wait, stop details and usage", async () => {
    const tool = createGoalReadTool(async () => ({ goalId: "g", objectiveVersion: 2, objective: "work", status: "paused",
      wait: { kind: "external", targetRunId: "child", deadlineAt: 12345 }, reason: "task failed", stopReason: "external_run_failed",
      autoTurnsUsed: 3, maxAutoTurns: 10, knownTokens: 42, usageIncomplete: true, tokenBudget: 100,
      phase: "executing", requirements: ["obsolete"], recentEvidence: ["obsolete"],
    }));
    const result = await tool.execute({}, { cwd: process.cwd() });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      goalId: "g", objectiveVersion: 2, objective: "work", status: "paused",
      wait: { kind: "external", targetRunId: "child", deadlineAt: 12345 }, reason: "task failed", stopReason: "external_run_failed",
      autoTurnsUsed: 3, maxAutoTurns: 10, knownTokens: 42, usageIncomplete: true, tokenBudget: 100,
    });
  });
});
