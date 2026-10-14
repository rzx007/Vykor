import { describe, expect, it } from "vitest";
import { createGoalRunContribution } from "./goal-extension.js";

describe("goal run contribution", () => {
  it("reads a fresh bound snapshot for guidance and GoalRead without accepting IDs", async () => {
    let reads = 0;
    const snapshot = { goalId: "g", objectiveVersion: 1, phase: "preparing", objective: "整理目标",
      sourceInputIds: ["input-1"], requirements: [], autoTurnsUsed: 0, maxAutoTurns: 3,
      knownTokens: 7, usageIncomplete: false };
    const contribution = await createGoalRunContribution({ goalId: "g", objectiveVersion: 1, phase: "preparing",
      readSnapshot: async () => { reads++; return { ...snapshot, knownTokens: reads }; },
    } as never);
    expect(reads).toBe(1);
    const read = contribution.tools?.find(item => item.definition.name === "GoalRead")?.definition;
    expect(read).toBeDefined();
    const result = await read!.execute({}, { cwd: process.cwd() });
    expect(JSON.parse((result.content[0] as { text: string }).text).knownTokens).toBe(2);
    expect((await read!.execute({ goalId: "another" }, { cwd: process.cwd() })).isError).toBe(true);
    expect(reads).toBe(2);
    expect(contribution.systemGuidance).toContain('"sourceInputIds":["input-1"]');
    expect(contribution.tools?.find(item => item.definition.name === "GoalAssessment")).toMatchObject({ endRunOnSuccess: true });
  });
});
