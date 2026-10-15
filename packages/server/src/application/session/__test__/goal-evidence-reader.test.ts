import { describe, expect, it } from "vitest";
import { readGoalEvidence, readGoalDiagnostics } from "../goal-evidence-reader.js";
import { classifyGoalCompletion } from "../goal-assessment-policy.js";

const sha = "sha256:" + "a".repeat(64);
const goal = { id: "g", sessionId: "s", objectiveVersion: 2, phase: "executing", requirements: [{ id: "R1", verification: { kind: "artifact_review", artifact: "/work/a", standard: "matches" } }] } as any;
const ref = { goalId: "g", objectiveVersion: 2, runId: "root", messagePartId: "part", criterion: "checked" };
const assessment = { goalId: "g", objectiveVersion: 2, runId: "root", evidenceRefs: [], requirements: [{ requirementId: "R1", status: "satisfied", explanation: "审查符合标准", evidenceRefs: [ref] }] } as any;
function records() {
  const runs = new Map<string, any>([["root", { id: "root", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } }]]);
  const messages = [{ id: "message", sessionId: "s", runId: "root" }];
  const parts: any[] = [{ id: "part", sessionId: "s", messageId: "message", type: "tool", toolName: "Read", status: "completed", output: [{ type: "text", text: "1: visible" }], metadata: { executionState: "completed", hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a", operation: "read", afterDigest: sha, completed: true, bodyVisible: true }] } } }];
  return { runs, messages, parts, context: { runs: { getRun: (id: string) => runs.get(id) }, conversations: { listMessages: () => messages as any, listMessageParts: () => parts as any }, goals: { getGoalVersion: (_id: string, version: number) => ({ goalId: "g", objectiveVersion: version, frozenAt: 1, requirements: goal.requirements }) as any } } };
}
describe("evidence identity and current validity", () => {
  it("treats suggested commands as guidance while preserving explicit required commands", () => {
    const { context, parts } = records();
    parts[0] = { ...parts[0], toolName: "Shell", input: { command: "npx vitest run", workdir: "/repo/packages/protocol" }, metadata: { executionState: "completed" } };
    const verification = { kind: "check", command: "npx vitest run packages/protocol/src/session-goals.test.ts", environment: "local", expected: "tests pass" };
    const checkGoal = { ...goal, requirements: [{ id: "R1", verification }] } as any;
    expect(readGoalEvidence(context, checkGoal, assessment)).toMatchObject([{ supportsCompletion: true }]);
    const required = { ...checkGoal, requirements: [{ id: "R1", verification: { ...verification, commandPolicy: "required" } }] } as any;
    expect(readGoalEvidence(context, required, assessment)).toEqual([]);
    parts[0].input.command = verification.command;
    expect(readGoalEvidence(context, required, assessment)).toMatchObject([{ supportsCompletion: true }]);
    for (const name of ["Read", "GoalRead", "Inspect"]) {
      parts[0].toolName = name;
      expect(readGoalEvidence(context, checkGoal, assessment)).toEqual([]);
    }
    parts[0].toolName = "Shell";
    parts[0].isError = true;
    expect(readGoalEvidence(context, checkGoal, assessment)).toEqual([]);
  });
  it("previews only the current bound running root and never weakens final settlement", () => {
    const { context, runs } = records();
    runs.get("root").status = "running";
    const current = { ...goal, status: "active", currentRunId: "root" };
    expect(readGoalEvidence(context, current, assessment)).toEqual([]);
    expect(readGoalEvidence(context, current, assessment, { preview: true })).toHaveLength(1);
    expect(readGoalEvidence(context, { ...current, currentRunId: "other" }, assessment, { preview: true })).toEqual([]);
  });
  it("retains missing or deleted artifact facts for progress while refusing completion", () => {
    for (const operation of ["read", "patch"]) {
      const { context, parts } = records();
      const file = parts[0].metadata.hostFileFacts.files[0];
      Object.assign(file, { operation, afterDigest: "missing", bodyVisible: false,
        ...(operation === "patch" ? { beforeDigest: sha } : {}) });
      const verified = readGoalEvidence(context, goal, assessment);
      expect(verified).toMatchObject([{ supportsCompletion: false, facts: { artifacts: [{ afterDigest: "missing" }] } }]);
      expect(classifyGoalCompletion(goal, assessment, verified)).toMatchObject({ kind: "continue" });
    }
  });
  it("invalidates an artifact reference after a conflicting same-round write or deletion, including unknown order", () => {
    for (const change of [
      { operation: "write", digest: "sha256:" + "b".repeat(64), ordered: true },
      { operation: "patch", digest: "missing", ordered: true },
      { operation: "write", digest: "sha256:" + "b".repeat(64), ordered: false },
    ]) {
      const { context, parts, messages, runs } = records();
      Object.assign(messages[0], { seq: 1 });
      parts[0].metadata.modelGeneration = { generationId: "generation-1", attempt: 1, committed: true };
      messages.push({ id: "later-message", sessionId: "s", runId: "root", seq: 2 } as any);
      parts.push({ ...parts[0], id: "later-part", messageId: change.ordered ? "later-message" : "message",
        metadata: { executionState: "completed", modelGeneration: { generationId: change.ordered ? "generation-2" : "generation-1", attempt: 1, committed: true },
          hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a", operation: change.operation,
            beforeDigest: sha, afterDigest: change.digest, completed: true }] } } });
      const verified = readGoalEvidence(context, goal, assessment);
      expect(verified).toMatchObject([{ supportsCompletion: false }]);
      expect(classifyGoalCompletion(goal, assessment, verified)).toMatchObject({ kind: "continue" });
      runs.get("root").status = "running";
      expect(readGoalEvidence(context, { ...goal, status: "active", currentRunId: "root" }, assessment, { preview: true }))
        .toMatchObject([{ supportsCompletion: false }]);
    }
  });
  it("accepts settled current facts and separates actual failed output from completion evidence", () => {
    const { context, parts } = records();
    expect(readGoalEvidence(context, goal, assessment)).toMatchObject([{ requirementId: "R1", verifiedForVersion: 2, origin: { runId: "root", messagePartId: "part" } }]);
    parts[0].isError = true;
    parts[0].output = { content: [{ type: "text", text: "resource not found" }], isError: true };
    expect(readGoalEvidence(context, goal, assessment)).toEqual([]);
    expect(readGoalDiagnostics(context, goal, assessment)).toMatchObject([{ kind: "tool_error", summary: "resource not found" }]);
  });
  it("rejects an unrelated run in the same session and accepts only the trusted descendant chain", () => {
    const { context, runs, messages } = records();
    messages[0].runId = "child";
    const childRef = { ...ref, runId: "child" };
    const childAssessment = { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [childRef] }] };
    runs.set("child", { id: "child", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } });
    expect(readGoalEvidence(context, goal, childAssessment)).toEqual([]);
    runs.get("child").metadata.parentRunId = "root";
    expect(readGoalEvidence(context, goal, childAssessment)).toHaveLength(1);
  });
  it("requires same-goal historical binding and current matching read of every original artifact", () => {
    const { context, runs, messages, parts } = records();
    runs.set("old", { id: "old", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 1 } });
    messages.push({ id: "old-message", sessionId: "s", runId: "old" });
    parts.push({ ...parts[0], id: "old-part", messageId: "old-message" });
    const historicalRef = { ...ref, objectiveVersion: 1, runId: "old", messagePartId: "old-part", revalidation: { messagePartIds: ["part"], environmentKey: "environment", dependencies: [{ subjectKey: "file:a", digest: sha }] } };
    const historicalAssessment = { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [historicalRef] }] };
    expect(readGoalEvidence(context, goal, historicalAssessment)).toHaveLength(1);
    parts[0].metadata.hostFileFacts.files[0].afterDigest = "sha256:" + "b".repeat(64);
    expect(readGoalEvidence(context, goal, historicalAssessment)).toEqual([]);
  });
  it("does not accept historical test dependency claims that lacked a recorded complete dependency set", () => {
    const { context, runs, messages, parts } = records();
    runs.set("old", { id: "old", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 1 } });
    messages.push({ id: "old-message", sessionId: "s", runId: "old" });
    parts.push({ ...parts[0], id: "old-part", messageId: "old-message", toolName: "Shell", input: { command: "test" }, metadata: { executionState: "completed" } });
    const oldRef = { ...ref, objectiveVersion: 1, runId: "old", messagePartId: "old-part", revalidation: { messagePartIds: ["part"], environmentKey: "environment", command: "test", expected: "pass", dependencies: [{ subjectKey: "file:a", digest: sha }] } };
    const checkGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "check", command: "test", environment: "environment", expected: "pass" } }] };
    expect(readGoalEvidence(context, checkGoal, { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [oldRef] }] })).toEqual([]);
  });
  it("does not use a file mutation as satisfied-check proof but retains it as artifact progress", () => {
    const { context, parts } = records();
    parts[0].toolName = "Write";
    parts[0].metadata.hostFileFacts.files[0] = { ...parts[0].metadata.hostFileFacts.files[0], operation: "write", beforeDigest: "missing" };
    const checkGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "check", command: "test", environment: "environment", expected: "pass" } }] };
    const result = readGoalEvidence(context, checkGoal, { ...assessment, progressSignals: [{ requirementId: "R1", kind: "artifact_changed", subjectKey: "model", evidenceRefs: [ref] }] });
    expect(result).toMatchObject([{ supportsCompletion: false, facts: { artifacts: [{ beforeDigest: "missing" }] } }]);
  });
  it("revalidates a previous root in the same formal version instead of treating it as this round", () => {
    const { context, runs, messages, parts } = records();
    runs.set("old", { id: "old", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } });
    messages.push({ id: "old-message", sessionId: "s", runId: "old" });
    parts.push({ ...parts[0], id: "old-part", messageId: "old-message" });
    const oldRef = { ...ref, runId: "old", messagePartId: "old-part", revalidation: { messagePartIds: ["part"], environmentKey: "environment", dependencies: [{ subjectKey: "file:a", digest: sha }] } };
    expect(readGoalEvidence(context, goal, { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [oldRef] }] })).toHaveLength(1);
  });
  it("verifies an external transition without letting failed result parts prove completion", () => {
    const { context, runs, messages, parts } = records();
    runs.get("root").metadata.goalWaitSource = { kind: "external", goalId: "g", objectiveVersion: 2, ownerRunId: "owner", targetRunId: "target", observedStatus: "running", deadlineAt: 100 };
    runs.set("owner", { id: "owner", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } });
    runs.set("target", { id: "target", sessionId: "s", status: "completed", finishedAt: 90, metadata: { goalId: "g", goalObjectiveVersion: 2, parentRunId: "owner" } });
    messages[0].runId = "target";
    parts[0].isError = true;
    const targetRef = { ...ref, runId: "target" };
    const result = readGoalEvidence(context, goal, { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [targetRef] }] });
    expect(result).toMatchObject([{ supportsCompletion: false, facts: { external: { waitOwnerRunId: "owner", targetRunId: "target", observedStatus: "running", status: "completed", resultPartId: "part" } } }]);
  });
  it("resolves a relative artifact from its trusted recorded workspace without reading the host filesystem", () => {
    const { context, parts } = records();
    parts[0].metadata.hostFileFacts.executionRoot = "/work";
    parts[0].metadata.hostFileFacts.pathStyle = "posix";
    const relativeGoal = { ...goal, requirements: [{ ...goal.requirements[0], verification: { ...goal.requirements[0].verification, artifact: "a" } }] };
    expect(readGoalEvidence(context, relativeGoal, assessment)).toHaveLength(1);
  });
});
