import { describe, expect, it } from "vitest";
import { createGoalRunContribution } from "../goal-run-contribution.js";

describe("goal run contribution", () => {
  it("reads fresh state and keeps the complete objective without enabling evidence IDs or ending the run", async () => {
    let reads = 0;
    const objective = "目标原文".repeat(2000);
    const contribution = await createGoalRunContribution({ goalId: "g", objectiveVersion: 1,
      readSnapshot: async () => ({ goalId: "g", objectiveVersion: 1, status: "active", objective,
        autoTurnsUsed: 0, maxAutoTurns: 0, knownTokens: ++reads, usageIncomplete: false }),
      submitUpdate: async () => ({ recorded: true }),
    });
    expect(reads).toBe(1);
    expect(contribution.systemGuidance).toContain(objective);
    expect(contribution.exposeToolResultIds).toBeUndefined();
    expect(contribution.tools?.map(item => item.definition.name)).toEqual(["GoalUpdate", "GoalRead"]);
    expect(contribution.tools?.every(item => item.permission === "host-internal" && !item.endRunOnSuccess)).toBe(true);
    const read = contribution.tools!.find(item => item.definition.name === "GoalRead")!.definition;
    const result = await read.execute({}, { cwd: process.cwd() });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      objective, status: "active", knownTokens: 2, maxAutoTurns: "unlimited",
    });
    expect((await read.execute({ goalId: "another" }, { cwd: process.cwd() })).isError).toBe(true);
    expect(reads).toBe(2);
  });
});
