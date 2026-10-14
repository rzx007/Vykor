import type { GoalAssessment, SessionGoal, VerifiedGoalProgressSignal } from "@vykor/protocol";
import type { VerifiedGoalDiagnostic, VerifiedGoalEvidence } from "./goal-evidence-reader.js";
import { classifyGoalCompletion, requirementEvidenceSatisfied, validateRequirementCoverage } from "./goal-assessment-policy.js";

export interface GoalProgressEvaluation {
  trustedProgress: boolean;
  stagnationCount: number;
  noProgressCount: number;
  disposition?: "paused" | "blocked";
  verifiedSignals: VerifiedGoalProgressSignal[];
}
function diagnosticKey(diagnostics: VerifiedGoalDiagnostic[]): string {
  return [...new Set(diagnostics.map(item => `${item.kind}:${item.summary.replace(/\s+/g, " ").trim()}`))].sort().join("\n");
}
function sameOrigin(evidence: VerifiedGoalEvidence, refs: NonNullable<GoalAssessment["progressSignals"]>[number]["evidenceRefs"]): boolean {
  return refs.some(ref => ref.goalId === evidence.origin.goalId && ref.objectiveVersion === evidence.origin.objectiveVersion
    && ref.runId === evidence.origin.runId && ref.messagePartId === evidence.origin.messagePartId);
}

/** A pure policy: candidates become progress only through already verified facts. */
export function evaluateGoalProgress(input: {
  goal: SessionGoal; assessment: GoalAssessment; evidence: VerifiedGoalEvidence[];
  diagnostics: VerifiedGoalDiagnostic[]; history: GoalAssessment[];
}): GoalProgressEvaluation {
  const { goal, assessment, evidence, diagnostics } = input;
  const unchanged: GoalProgressEvaluation = { trustedProgress: false, stagnationCount: goal.stagnationCount, noProgressCount: goal.noProgressCount, verifiedSignals: [] };
  const history = input.history.filter(item => item.goalId === goal.id && item.objectiveVersion === goal.objectiveVersion);
  const duplicate = history.find(item => item.runId === assessment.runId && item.hostProgress);
  if (duplicate?.hostProgress) return { ...duplicate.hostProgress, trustedProgress: duplicate.hostProgress.verifiedSignals.length > 0 };
  if (goal.phase !== "executing" || goal.status !== "active" || assessment.goalId !== goal.id || assessment.objectiveVersion !== goal.objectiveVersion
    || goal.currentRunId && goal.currentRunId !== assessment.runId || assessment.progressAssessment.kind === "waiting"
    || assessment.decision === "waiting_user" || assessment.wait?.kind === "approval" || assessment.wait?.kind === "user" || assessment.wait?.kind === "external") return unchanged;
  let waitingForAcceptance = false;
  if (assessment.decision === "complete") {
    try { waitingForAcceptance = classifyGoalCompletion(goal, assessment, evidence).kind === "waiting_user"; } catch { /* Coverage is checked below. */ }
  }
  const verifiedSignals: VerifiedGoalProgressSignal[] = [];
  const priorSignals = history.flatMap(item => item.hostProgress?.verifiedSignals ?? []);
  const validEvidence = evidence.filter(item => item.origin.goalId === goal.id && item.verifiedForVersion === goal.objectiveVersion);
  let coverageValid = true;
  try { validateRequirementCoverage(goal.requirements, assessment.requirements); } catch { coverageValid = false; }
  if (coverageValid) for (const requirement of goal.requirements) {
    if (!requirementEvidenceSatisfied(goal, assessment, validEvidence, requirement.id)
      || priorSignals.some(signal => signal.kind === "requirement_satisfied" && signal.requirementId === requirement.id)) continue;
    verifiedSignals.push({ requirementId: requirement.id, subjectKey: `requirement:${requirement.id}`, kind: "requirement_satisfied", from: "incomplete", to: "satisfied",
      origins: validEvidence.filter(item => item.requirementId === requirement.id).map(item => item.origin) });
  }
  for (const candidate of assessment.progressSignals ?? []) {
    const report = assessment.requirements?.find(item => item.requirementId === candidate.requirementId);
    if (!coverageValid || !goal.requirements.some(item => item.id === candidate.requirementId) || !report?.explanation.trim()) continue;
    const matched = validEvidence.filter(item => item.requirementId === candidate.requirementId && sameOrigin(item, candidate.evidenceRefs));
    if (candidate.kind === "artifact_changed") for (const item of matched) for (const artifact of item.facts.artifacts ?? []) {
      if (!artifact.beforeDigest || artifact.beforeDigest === artifact.afterDigest) continue;
      const states = priorSignals.filter(signal => signal.kind === "artifact_changed" && signal.subjectKey === artifact.subjectKey);
      const known = new Set(states.flatMap(signal => signal.kind === "artifact_changed" ? [signal.beforeDigest, signal.afterDigest] : []));
      for (const observed of history.flatMap(item => item.hostEvidence ?? []).filter(item => item.verifiedForVersion === goal.objectiveVersion)) {
        for (const previousArtifact of observed.facts.artifacts ?? []) if (previousArtifact.subjectKey === artifact.subjectKey) {
          if (previousArtifact.beforeDigest) known.add(previousArtifact.beforeDigest);
          known.add(previousArtifact.afterDigest);
        }
      }
      if (known.has(artifact.afterDigest) || verifiedSignals.some(signal => signal.kind === "artifact_changed" && signal.subjectKey === artifact.subjectKey && signal.afterDigest === artifact.afterDigest)) continue;
      verifiedSignals.push({ requirementId: candidate.requirementId, kind: "artifact_changed", subjectKey: artifact.subjectKey,
        beforeDigest: artifact.beforeDigest, afterDigest: artifact.afterDigest, origins: [item.origin] });
    }
    if (candidate.kind === "external_terminal") for (const item of matched) {
      const external = item.facts.external;
      if (!external || external.observedStatus !== "pending" && external.observedStatus !== "running"
        || priorSignals.some(signal => signal.kind === "external_terminal" && signal.waitOwnerRunId === external.waitOwnerRunId && signal.targetRunId === external.targetRunId)
        || verifiedSignals.some(signal => signal.kind === "external_terminal" && signal.waitOwnerRunId === external.waitOwnerRunId && signal.targetRunId === external.targetRunId)) continue;
      verifiedSignals.push({ requirementId: candidate.requirementId, kind: "external_terminal", subjectKey: `external:${external.waitOwnerRunId}:${external.targetRunId}`,
        waitOwnerRunId: external.waitOwnerRunId, targetRunId: external.targetRunId, observedStatus: external.observedStatus,
        terminalStatus: external.status, resultPartId: external.resultPartId, origins: [item.origin] });
    }
  }
  const trustedProgress = verifiedSignals.length > 0;
  const stagnationCount = trustedProgress ? 0 : waitingForAcceptance ? goal.stagnationCount : goal.stagnationCount + 1;
  const currentDiagnostics = diagnosticKey(diagnostics);
  const previous = [...history].reverse().find(item => item.runId !== assessment.runId && item.hostProgress);
  const previousDiagnostics = diagnosticKey(previous?.hostDiagnostics ?? []);
  const noProgressCount = waitingForAcceptance ? goal.noProgressCount : trustedProgress || !currentDiagnostics ? 0 : currentDiagnostics === previousDiagnostics ? goal.noProgressCount + 1 : 1;
  const noRoute = !assessment.nextStep?.trim();
  return { trustedProgress, stagnationCount, noProgressCount, verifiedSignals,
    ...(!waitingForAcceptance && stagnationCount >= 3 ? { disposition: noProgressCount >= 3 && noRoute ? "blocked" as const : "paused" as const } : {}) };
}
