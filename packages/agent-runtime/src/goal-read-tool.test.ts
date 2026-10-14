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
  it("rechecks version and phase on every call", async () => {
    let version = 1;
    const contribution = await createGoalRunContribution({ goalId: "g", objectiveVersion: 1, phase: "executing",
      readSnapshot: async () => ({ goalId: "g", objectiveVersion: version, phase: "executing", objective: "work",
        sourceInputIds: [], requirements: [], autoTurnsUsed: 0, maxAutoTurns: 3, knownTokens: 0, usageIncomplete: false }),
    });
    version = 2;
    const read = contribution.tools!.find(item => item.definition.name === "GoalRead")!.definition;
    expect((await read.execute({}, { cwd: process.cwd() })).isError).toBe(true);
    expect(contribution.tools!.find(item => item.definition.name === "GoalAssessment")!.endRunOnSuccess).toBeUndefined();
  });
});
