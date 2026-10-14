import { describe, expect, it } from "vitest";
import { evaluateGoalProgress } from "../goal-progress-policy.js";

const origin = { goalId: "g", objectiveVersion: 1, runId: "run", messagePartId: "part" };
const goal = { id: "g", objectiveVersion: 1, phase: "executing", status: "active", stagnationCount: 0, noProgressCount: 0, requirements: [{ id: "R1", verification: { kind: "check" } }] } as any;
const assessment = { goalId: "g", objectiveVersion: 1, runId: "run", decision: "continue", progressAssessment: { kind: "progress", blockerKey: "new-log" }, requirements: [{ requirementId: "R1", status: "incomplete", explanation: "文件推进", evidenceRefs: [{ ...origin, criterion: "变化" }] }], progressSignals: [{ requirementId: "R1", kind: "artifact_changed", subjectKey: "model-random", evidenceRefs: [{ ...origin, criterion: "变化" }] }] } as any;
const evidence = (before: string, after: string) => [{ requirementId: "R1", origin, verifiedForVersion: 1, facts: { artifacts: [{ subjectKey: "host-file", beforeDigest: before, afterDigest: after }] } }] as any;
const evaluate = (changes: any = {}) => evaluateGoalProgress({ goal, assessment, evidence: [], diagnostics: [], history: [], ...changes });
describe("verified progress", () => {
  it("pauses after three rounds even if claimed progress and blocker text change", () => {
    expect(evaluate({ goal: { ...goal, stagnationCount: 2 } })).toMatchObject({ trustedProgress: false, stagnationCount: 3, noProgressCount: 0, disposition: "paused" });
  });
  it("counts each artifact state once and does not reset A to B to A to B", () => {
    const first = evaluate({ evidence: evidence("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)) });
    expect(first).toMatchObject({ trustedProgress: true, stagnationCount: 0 });
    expect(first.verifiedSignals[0]).toMatchObject({ subjectKey: "host-file" });
    const history = [{ ...assessment, runId: "previous", hostProgress: first }];
    expect(evaluate({ evidence: evidence("sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64)), history })).toMatchObject({ trustedProgress: false, stagnationCount: 1 });
    expect(evaluate({ evidence: evidence("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)), history })).toMatchObject({ trustedProgress: false });
  });
  it("blocks only after three consecutive real matching diagnostics with no executable next step", () => {
    const diagnostic = { origin, kind: "tool_error", summary: "resource unavailable" };
    expect(evaluate({ goal: { ...goal, stagnationCount: 2, noProgressCount: 2 }, diagnostics: [diagnostic], history: [{ ...assessment, runId: "previous", hostProgress: { verifiedSignals: [], stagnationCount: 2, noProgressCount: 2 }, hostDiagnostics: [diagnostic] }] })).toMatchObject({ noProgressCount: 3, disposition: "blocked" });
    expect(evaluate({ goal: { ...goal, stagnationCount: 2, noProgressCount: 2 }, diagnostics: [diagnostic], assessment: { ...assessment, nextStep: "Use another available resource" }, history: [] })).toMatchObject({ disposition: "paused" });
  });
  it("excludes preparation, waiting and stale runs from round counters", () => {
    for (const changes of [{ goal: { ...goal, phase: "preparing" } }, { assessment: { ...assessment, progressAssessment: { kind: "waiting" } } }, { goal: { ...goal, currentRunId: "another" } }]) {
      expect(evaluate(changes)).toMatchObject({ stagnationCount: 0, noProgressCount: 0, verifiedSignals: [] });
    }
  });
  it("consumes a real external transition once and never treats an already terminal wait as progress", () => {
    const current = { ...assessment, progressSignals: [{ ...assessment.progressSignals[0], kind: "external_terminal" }] };
    const externalEvidence = [{ requirementId: "R1", origin, verifiedForVersion: 1, facts: { external: { waitOwnerRunId: "owner", targetRunId: "child", observedStatus: "running", status: "completed", resultPartId: "part" } } }];
    const first = evaluate({ assessment: current, evidence: externalEvidence });
    expect(first.trustedProgress).toBe(true);
    expect(evaluate({ assessment: current, evidence: externalEvidence, history: [{ ...current, runId: "prior", hostProgress: first }] }).trustedProgress).toBe(false);
    expect(evaluate({ assessment: current, evidence: [{ ...externalEvidence[0], facts: { external: { ...externalEvidence[0].facts.external, observedStatus: "completed" } } }] }).trustedProgress).toBe(false);
  });
  it("does not count repeat satisfaction or replayed settlement as new work", () => {
    const completed = { ...assessment, requirements: [{ ...assessment.requirements[0], status: "satisfied" }] };
    const proof = evidence("sha256:" + "a".repeat(64), "sha256:" + "a".repeat(64));
    const first = evaluate({ assessment: completed, evidence: proof });
    expect(first.verifiedSignals).toMatchObject([{ kind: "requirement_satisfied", requirementId: "R1" }]);
    expect(evaluate({ assessment: completed, evidence: proof, history: [{ ...completed, runId: "previous", hostProgress: first }] }).trustedProgress).toBe(false);
    expect(evaluate({ assessment: completed, history: [{ ...completed, hostProgress: first }] })).toEqual(first);
  });
  it("does not increment rounds while a completed proposal only awaits scoped user acceptance", () => {
    const waitingGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "user_acceptance" } }] };
    const waitingAssessment = { ...assessment, decision: "complete", requirements: [{ ...assessment.requirements[0], status: "needs_user" }], progressSignals: [] };
    expect(evaluate({ goal: waitingGoal, assessment: waitingAssessment })).toMatchObject({ stagnationCount: 0, noProgressCount: 0 });
  });
  it("does not count a previously observed artifact state after withholding its candidate signal", () => {
    const history = [{ ...assessment, runId: "previous", progressSignals: [], hostProgress: { verifiedSignals: [], stagnationCount: 1, noProgressCount: 0 }, hostEvidence: evidence("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)) }];
    expect(evaluate({ evidence: evidence("sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64)), history }).trustedProgress).toBe(false);
  });
});
