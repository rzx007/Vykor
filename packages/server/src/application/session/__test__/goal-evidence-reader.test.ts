import { describe, expect, it } from "vitest";
import { readGoalEvidence, readGoalDiagnostics, describeGoalEvidenceRejection } from "../goal-evidence-reader.js";
import { classifyGoalCompletion } from "../goal-assessment-policy.js";

const sha = "sha256:" + "a".repeat(64);
const goal = { id: "g", sessionId: "s", objectiveVersion: 2, phase: "executing", requirements: [{ id: "R1", verification: { kind: "artifact_review", artifact: "/work/a", standard: "matches" } }] } as any;
const ref = { goalId: "g", objectiveVersion: 2, runId: "root", messagePartId: "part", criterion: "checked" };
const assessment = { goalId: "g", objectiveVersion: 2, runId: "root", evidenceRefs: [], requirements: [{ requirementId: "R1", status: "satisfied", explanation: "审查符合标准", evidenceRefs: [ref] }] } as any;
function records() {
  const runs = new Map<string, any>([["root", { id: "root", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } }]]);
  const messages = [{ id: "message", sessionId: "s", runId: "root" }];
  const parts: any[] = [{ id: "part", sessionId: "s", messageId: "message", type: "tool", toolName: "Read", status: "completed", output: [{ type: "text", text: "1: visible" }], metadata: { executionState: "completed", hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a", operation: "read", afterDigest: sha, completed: true, bodyVisible: true }] } } }];
  return { runs, messages, parts, context: { runs: { getRun: (id: string) => runs.get(id),
    listGoalRuns: (goalId: string, version?: number) => [...runs.values()].filter(run => run.metadata.goalId === goalId && (version === undefined || run.metadata.goalObjectiveVersion === version)) },
    conversations: { listMessages: (sessionId: string) => messages.filter(message => message.sessionId === sessionId) as any,
      listMessageParts: (sessionId: string) => parts.filter(part => part.sessionId === sessionId) as any },
    goals: { getGoalVersion: (_id: string, version: number) => ({ goalId: "g", objectiveVersion: version, frozenAt: 1, requirements: goal.requirements }) as any } } };
}
describe("evidence identity and current validity", () => {
  it.each(["Read", "Agent", "JobRead", "JobWait"])("accepts a prior %s call only for its declared tool, without turning it into a Shell check", toolName => {
    const { context, parts } = records();
    parts[0].toolName = toolName;
    if (toolName !== "Read") delete parts[0].metadata.hostFileFacts;
    const recordGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "tool_result", toolName, outcome: "success", standard: "核对已经发生的调用" } }] } as any;
    expect(classifyGoalCompletion(recordGoal, assessment, readGoalEvidence(context, recordGoal, assessment))).toMatchObject({ kind: "completed" });
    parts[0].toolName = "Shell";
    parts[0].input = { command: "echo summary" };
    expect(readGoalEvidence(context, recordGoal, assessment)).toEqual([]);
    const old = { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [{ ...ref, objectiveVersion: 1 }] }] };
    expect(readGoalEvidence(context, recordGoal, old)).toEqual([]);
  });
  it("distinguishes a stale file from a wrong path and accepts a later read of the changed file", () => {
    const { context, runs, messages, parts } = records();
    runs.get("root").status = "running";
    const current = { ...goal, status: "active", currentRunId: "root" };
    Object.assign(messages[0], { seq: 1 });
    parts[0].metadata.modelGeneration = { generationId: "before", committed: true };
    const after = "sha256:" + "b".repeat(64);
    runs.set("child", { id: "child", sessionId: "child-session", status: "running", metadata: { goalId: "g", goalObjectiveVersion: 2, parentRunId: "root" } });
    messages.push({ id: "child-message", sessionId: "child-session", runId: "child" });
    parts.push({ ...parts[0], id: "child-write", sessionId: "child-session", messageId: "child-message", toolName: "Write",
      metadata: { executionState: "completed", hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a", operation: "write", beforeDigest: sha, afterDigest: after, completed: true }] } } });
    expect(describeGoalEvidenceRejection(context, current, assessment, current.requirements[0], ref)).toContain("artifact_stale");
    expect(readGoalEvidence(context, current, assessment, { preview: true })).toMatchObject([{ supportsCompletion: false }]);
    const wrongPath = { ...current.requirements[0], verification: { kind: "artifact_review", artifact: "/work/report.md", standard: "报告" } } as any;
    const rejected = describeGoalEvidenceRejection(context, current, assessment, wrongPath, ref);
    expect(rejected).toContain("artifact_path_mismatch");
    expect(rejected).toContain("/work/report.md");
    expect(rejected).toContain("/work/a");
    messages.push({ id: "after-message", sessionId: "s", runId: "root", seq: 2 } as any);
    parts.push({ ...parts[0], id: "new-read", messageId: "after-message", metadata: { executionState: "completed", modelGeneration: { generationId: "after", committed: true },
      hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a", operation: "read", afterDigest: after, completed: true, bodyVisible: true }] } } });
    const fresh = { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [{ ...ref, messagePartId: "new-read" }] }] };
    expect(readGoalEvidence(context, current, fresh, { preview: true })).toMatchObject([{ supportsCompletion: true }]);
    runs.get("root").status = "completed";
    expect(classifyGoalCompletion(current, fresh, readGoalEvidence(context, current, fresh))).toMatchObject({ kind: "completed" });
  });
  it("accepts only a host rejection with the required code, not arbitrary GoalAssessment errors", () => {
    const { context, parts } = records();
    const rejectedGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "tool_result", toolName: "GoalAssessment", outcome: "rejected", rejectionCode: "artifact_stale", standard: "旧证据因改写失效" } }] } as any;
    parts[0] = { ...parts[0], toolName: "GoalAssessment", status: "failed", isError: true,
      output: { failureKind: "precondition", content: [{ type: "text", text: JSON.stringify({ kind: "goal_assessment_rejected", evidenceIssues: [{ code: "artifact_stale", requirementId: "file", messagePartId: "old", message: "旧证据过期" }] }) }] }, metadata: { executionState: "not_started" } };
    expect(readGoalEvidence(context, rejectedGoal, assessment)).toMatchObject([{ supportsCompletion: true }]);
    for (const content of ["invalid input", JSON.stringify({ kind: "goal_assessment_rejected", evidenceIssues: [{ code: "verification_tool_mismatch" }] })]) {
      parts[0].output.content = [{ type: "text", text: content }];
      expect(readGoalEvidence(context, rejectedGoal, assessment)).toEqual([]);
    }
  });
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
  it.each([false, true])("invalidates old artifact evidence after a running child writes or deletes it (preview=%s)", preview => {
    for (const afterDigest of ["sha256:" + "b".repeat(64), "missing"]) {
      const { context, runs, messages, parts } = records();
      const current = { ...goal, status: "active", currentRunId: "root" };
      if (preview) runs.get("root").status = "running";
      runs.set("child", { id: "child", sessionId: "child-session", status: "running",
        metadata: { goalId: "g", goalObjectiveVersion: 2, parentRunId: "root" } });
      messages.push({ id: "child-message", sessionId: "child-session", runId: "child" });
      parts.push({ ...parts[0], id: "child-write", sessionId: "child-session", messageId: "child-message", toolName: "Write",
        metadata: { executionState: "completed", hostFileFacts: { environmentKey: "environment", files: [{ path: "/work/a", subjectKey: "file:a",
          operation: "write", beforeDigest: sha, afterDigest, completed: true }] } } });
      const verified = readGoalEvidence(context, current, assessment, { preview });
      expect(verified).toMatchObject([{ supportsCompletion: false }]);
      expect(classifyGoalCompletion(current, assessment, verified)).toMatchObject({ kind: "continue" });
      const childRef = { ...ref, runId: "child", messagePartId: "child-write" };
      expect(readGoalEvidence(context, current, { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [childRef] }] }, { preview })).toEqual([]);
    }
  });
  it.each(["unfinished", "unrelated", "other-environment"])("does not invalidate current artifacts for %s child writes", scenario => {
    const { context, runs, messages, parts } = records();
    runs.set("child", { id: "child", sessionId: "child-session", status: "running",
      metadata: { goalId: "g", goalObjectiveVersion: 2, ...(scenario === "unrelated" ? {} : { parentRunId: "root" }) } });
    messages.push({ id: "child-message", sessionId: "child-session", runId: "child" });
    parts.push({ ...parts[0], id: "child-write", sessionId: "child-session", messageId: "child-message", toolName: "Write",
      ...(scenario === "unfinished" ? { status: "running", output: undefined } : {}),
      metadata: { executionState: scenario === "unfinished" ? "unknown" : "completed", hostFileFacts: {
        environmentKey: scenario === "other-environment" ? "other" : "environment",
        files: [{ path: "/work/a", subjectKey: "file:a", operation: "write", beforeDigest: sha, afterDigest: "sha256:" + "b".repeat(64), completed: true }] } } });
    const verified = readGoalEvidence(context, goal, assessment);
    expect(verified).toMatchObject([{ supportsCompletion: true }]);
    expect(classifyGoalCompletion(goal, assessment, verified)).toMatchObject({ kind: "completed" });
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
  it("does not turn a previous owner's child tool result into completion proof through an external wait", () => {
    const { context, runs, messages } = records();
    runs.get("root").metadata.goalWaitSource = { kind: "external", goalId: "g", objectiveVersion: 2, ownerRunId: "owner", targetRunId: "target", observedStatus: "running", deadlineAt: 100 };
    runs.set("owner", { id: "owner", sessionId: "s", status: "completed", metadata: { goalId: "g", goalObjectiveVersion: 2 } });
    runs.set("target", { id: "target", sessionId: "s", status: "completed", finishedAt: 90, metadata: { goalId: "g", goalObjectiveVersion: 2, parentRunId: "owner" } });
    messages[0].runId = "target";
    const recordGoal = { ...goal, requirements: [{ id: "R1", verification: { kind: "tool_result", toolName: "Read", outcome: "success", standard: "本轮读取记录" } }] } as any;
    const report = { ...assessment, requirements: [{ ...assessment.requirements[0], evidenceRefs: [{ ...ref, runId: "target" }] }] };
    const result = readGoalEvidence(context, recordGoal, report);
    expect(result).toMatchObject([{ supportsCompletion: false, facts: { external: { targetRunId: "target" } } }]);
    expect(classifyGoalCompletion(recordGoal, report, result)).toMatchObject({ kind: "continue" });
  });
  it("resolves a relative artifact from its trusted recorded workspace without reading the host filesystem", () => {
    const { context, parts } = records();
    parts[0].metadata.hostFileFacts.executionRoot = "/work";
    parts[0].metadata.hostFileFacts.pathStyle = "posix";
    const relativeGoal = { ...goal, requirements: [{ ...goal.requirements[0], verification: { ...goal.requirements[0].verification, artifact: "./a" } }] };
    expect(readGoalEvidence(context, relativeGoal, assessment)).toHaveLength(1);
  });
});
