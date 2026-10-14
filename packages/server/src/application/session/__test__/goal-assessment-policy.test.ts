import { describe, expect, it } from "vitest";
import { classifyGoalCompletion, validateRequirementCoverage } from "../goal-assessment-policy.js";

const goal = { requirements: [
  { id: "R1", text: "接口检查", verification: { kind: "check" } },
  { id: "R2", text: "界面验收", verification: { kind: "user_acceptance" } },
] } as any;
const assessment = { requirements: [
  { requirementId: "R1", status: "incomplete", evidenceRefs: [], explanation: "检查未通过" },
  { requirementId: "R2", status: "needs_user", evidenceRefs: [], explanation: "待验收" },
] } as any;
describe("formal completion coverage", () => {
  it("continues unfinished objective checks before offering subjective acceptance", () => {
    expect(classifyGoalCompletion(goal, assessment, [])).toMatchObject({ kind: "continue" });
  });
  it("rejects omitted, duplicated or unknown formal conditions", () => {
    expect(() => validateRequirementCoverage(goal.requirements, [assessment.requirements[1]])).toThrow("goal_assessment_requirement_coverage_invalid");
    expect(() => validateRequirementCoverage(goal.requirements, [assessment.requirements[0], assessment.requirements[0]])).toThrow();
  });
  it("restricts acceptance to subjective IDs after every objective condition has valid proof", () => {
    const ref = { goalId: "g", objectiveVersion: 1, runId: "run", messagePartId: "part" };
    const currentGoal = { ...goal, id: "g", objectiveVersion: 1 };
    const completedObjective = { ...assessment, requirements: [{ ...assessment.requirements[0], status: "satisfied", explanation: "检查通过", evidenceRefs: [ref] }, assessment.requirements[1]] };
    expect(classifyGoalCompletion(currentGoal, completedObjective, [])).toMatchObject({ kind: "continue" });
    expect(classifyGoalCompletion(currentGoal, completedObjective, [{ requirementId: "R1", origin: ref, verifiedForVersion: 1, facts: {} }])).toMatchObject({ kind: "waiting_user", requirementIds: ["R2"] });
  });
});
