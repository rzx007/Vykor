import type { GoalAssessment, GoalRequirement, GoalRequirementAssessment, SessionGoal } from "@vykor/protocol";
import type { VerifiedGoalEvidence } from "./goal-evidence-reader.js";

export type GoalCompletionDisposition =
  | { kind: "completed" }
  | { kind: "continue"; reason: string }
  | { kind: "waiting_user"; reason: string; requirementIds: string[] };

export function validateRequirementCoverage(requirements: GoalRequirement[], assessment: GoalRequirementAssessment[] | undefined): void {
  const expected = new Set(requirements.map(item => item.id));
  const actual = assessment ?? [];
  if (!expected.size || expected.size !== requirements.length || actual.length !== requirements.length
    || new Set(actual.map(item => item.requirementId)).size !== expected.size
    || actual.some(item => !expected.has(item.requirementId))) throw new Error("goal_assessment_requirement_coverage_invalid");
}

export function requirementEvidenceSatisfied(goal: SessionGoal, assessment: GoalAssessment, evidence: VerifiedGoalEvidence[], requirementId: string): boolean {
  const formal = goal.requirements.find(item => item.id === requirementId);
  const report = assessment.requirements?.find(item => item.requirementId === requirementId);
  if (!formal || !report || report.status !== "satisfied") return false;
  if (formal.verification.kind === "user_acceptance") return Boolean(assessment.userReceipts?.some(receipt => receipt.objectiveVersion === goal.objectiveVersion && receipt.requirementIds.includes(requirementId)));
  return Boolean(report.explanation.trim()) && report.evidenceRefs.length > 0 && report.evidenceRefs.every(ref => evidence.some(item => item.requirementId === requirementId
    && item.verifiedForVersion === goal.objectiveVersion && item.origin.goalId === goal.id
    && item.origin.runId === ref.runId && item.origin.objectiveVersion === ref.objectiveVersion && item.origin.messagePartId === ref.messagePartId
    && item.supportsCompletion !== false && (!item.facts.external || item.facts.external.status === "completed")));
}

/** Objective checks and complete coverage take precedence over subjective acceptance. */
export function classifyGoalCompletion(goal: SessionGoal, assessment: GoalAssessment, evidence: VerifiedGoalEvidence[]): GoalCompletionDisposition {
  validateRequirementCoverage(goal.requirements, assessment.requirements);
  const reason = assessment.nextStep ?? assessment.remainingWork?.[0] ?? "继续完成剩余要求或补充当前有效证据";
  const objectiveUnfinished = goal.requirements.some(requirement => requirement.verification.kind !== "user_acceptance"
    && !requirementEvidenceSatisfied(goal, assessment, evidence, requirement.id));
  if (objectiveUnfinished || assessment.remainingWork?.length) return { kind: "continue", reason };
  const subjective = goal.requirements.filter(requirement => requirement.verification.kind === "user_acceptance"
    && !requirementEvidenceSatisfied(goal, assessment, evidence, requirement.id));
  if (subjective.some(requirement => assessment.requirements!.find(item => item.requirementId === requirement.id)?.status === "incomplete")) return { kind: "continue", reason };
  if (subjective.length) return { kind: "waiting_user", reason: "请验收这些需要主观判断的完成条件", requirementIds: subjective.map(item => item.id) };
  return { kind: "completed" };
}
