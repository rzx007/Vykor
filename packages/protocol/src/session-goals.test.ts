import { describe, expect, it } from "vitest";
import { parseCreateSessionGoalInput, parseUpdateSessionGoalInput, parseGoalActionInput, parseGoalAssessment } from "./session-goals.js";

describe("session goal protocol", () => {
  it("accepts unlimited automatic turns as zero and rejects invalid limits", () => {
    expect(parseCreateSessionGoalInput({ requestId: "r", objective: "finish", maxAutoTurns: 0 }).maxAutoTurns).toBe(0);
    for (const maxAutoTurns of [-1, 1.5, 1001]) expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", maxAutoTurns })).toThrow();
  });
  it("accepts a blocked-resume explanation without treating it as a question answer", () => {
    expect(parseGoalActionInput({ requestId: "blocked-resume", expectedRevision: 4, action: "resume", response: "所需配置已经补齐" })).toEqual({
      requestId: "blocked-resume", expectedRevision: 4, action: "resume", response: "所需配置已经补齐",
    });
    expect(() => parseGoalActionInput({ requestId: "clarification", expectedRevision: 4, action: "resume", questionId: "q", response: "选 A" })).toThrow();
  });
  it("requires a change reason and versioned answers, and keeps reprepare on resume", () => {
    const update = { requestId: "u", expectedRevision: 0, objective: "finish", changeKind: "refine", changeReason: "补充验收" };
    expect(parseUpdateSessionGoalInput({ ...update, replaceRequirementIds: ["R1"] })).toMatchObject({ changeKind: "refine", replaceRequirementIds: ["R1"] });
    expect(() => parseUpdateSessionGoalInput({ ...update, changeReason: "" })).toThrow();
    expect(() => parseUpdateSessionGoalInput({ ...update, changeKind: undefined })).toThrow();
    expect(() => parseUpdateSessionGoalInput({ ...update, actor: { kind: "local_user" } })).toThrow();
    const answer = { requestId: "a", expectedRevision: 0, action: "confirm", questionId: "q" };
    expect(() => parseGoalActionInput(answer)).toThrow();
    expect(() => parseGoalActionInput({ requestId: "a", expectedRevision: 0, action: "confirm", objectiveVersion: 1 })).toThrow();
    expect(parseGoalActionInput({ ...answer, objectiveVersion: 1 })).toMatchObject({ objectiveVersion: 1 });
    expect(parseGoalActionInput({ ...answer, action: "resume", objectiveVersion: 1, response: "answer" })).toMatchObject({ response: "answer" });
    expect(parseGoalActionInput({ requestId: "a", expectedRevision: 0, action: "resume", reprepare: true })).toMatchObject({ reprepare: true });
    expect(() => parseGoalActionInput({ ...answer, objectiveVersion: 1, reprepare: true })).toThrow();
  });

  it("separates preparation from executing and never accepts host-generated fields", () => {
    const binding = { goalId: "g", objectiveVersion: 2, runId: "r", phase: "preparing" as const };
    const candidate = { text: "测试通过", source: [{ kind: "input", inputId: "i", quote: "测试通过" }],
      verification: { kind: "check", method: "test", environment: "local", expected: "通过" }, constraints: [] };
    const ready = { decision: "ready", progress: "整理完成", progressAssessment: { kind: "progress", summary: "已整理" }, evidence: [], preparedRequirements: [candidate] };
    expect(parseGoalAssessment(ready, binding).preparedRequirements).toEqual([candidate]);
    expect(parseGoalAssessment({ ...ready, preparedRequirements: [{ ...candidate, verification: { ...candidate.verification, command: "npm test", commandPolicy: "required" } }] }, binding)
      .preparedRequirements?.[0]?.verification).toMatchObject({ command: "npm test", commandPolicy: "required" });
    for (const commandPolicy of ["unknown", 1, ["required"]]) expect(() => parseGoalAssessment({ ...ready,
      preparedRequirements: [{ ...candidate, verification: { ...candidate.verification, commandPolicy } }] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...ready, preparedRequirements: [{ ...candidate, verification: { ...candidate.verification, commandPolicy: "required" } }] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...ready, preparedRequirements: [{ ...candidate, id: "forged" }] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...ready, preparedRequirements: Array.from({ length: 65 }, () => candidate) }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...ready, decision: "complete" }, binding)).toThrow();
    expect(() => parseGoalAssessment(ready, { ...binding, phase: "executing" })).toThrow();
    for (const host of [{ hostProgress: { verifiedSignals: [] } }, { hostEvidence: [] }, { hostDiagnostics: [] }, { userReceipts: [] }]) expect(() => parseGoalAssessment({ ...ready, ...host }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...ready, preparedRequirements: [{ ...candidate, source: [{ kind: "document", path: "doc", digest: "short", quote: "测试通过", evidencePartId: "p" }] }] }, binding)).toThrow();
  });

  it("requires complete IDs and retains historical evidence origins and revalidation", () => {
    const definitions = [{ id: "R1", text: "pass", source: [], verification: { kind: "user_acceptance" as const, question: "pass?" }, constraints: [] }];
    const binding = { goalId: "g", objectiveVersion: 2, runId: "r", requirements: definitions };
    const ref = { goalId: "g", objectiveVersion: 1, runId: "old", messagePartId: "p", criterion: "pass",
      revalidation: { messagePartIds: ["current"], environmentKey: "local", dependencies: [{ subjectKey: "file", digest: `sha256:${"a".repeat(64)}` }] } };
    const complete = { decision: "complete", progress: "pass", progressAssessment: { kind: "progress", summary: "pass" }, evidence: [],
      requirements: [{ requirementId: "R1", status: "satisfied", explanation: "verified", evidenceRefs: [ref] }],
      progressSignals: [{ requirementId: "R1", kind: "requirement_satisfied", evidenceRefs: [ref], subjectKey: "R1" }] };
    expect(parseGoalAssessment(complete, binding).requirements?.[0].evidenceRefs[0]).toEqual(ref);
    expect(() => parseGoalAssessment({ ...complete, requirements: [] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...complete, requirements: [...complete.requirements, ...complete.requirements] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...complete, requirements: [{ ...complete.requirements[0], requirementId: "unknown" }] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...complete, evidenceRefs: [{ ...ref, goalId: "another" }] }, binding)).toThrow();
    expect(() => parseGoalAssessment({ ...complete, preparedRequirements: [] }, binding)).toThrow();
  });
  it("accepts safe positive total budgets and rejects malformed or cross-action fields", () => {
    expect(parseCreateSessionGoalInput({ requestId: "r", objective: "finish", tokenBudget: 5_000 })).toMatchObject({ tokenBudget: 5_000 });
    const action = { requestId: "r", expectedRevision: 0, action: "budget" };
    expect(parseGoalActionInput({ ...action, tokenBudget: Number.MAX_SAFE_INTEGER })).toMatchObject({ tokenBudget: Number.MAX_SAFE_INTEGER });
    expect(parseGoalActionInput({ ...action, tokenBudget: null })).toMatchObject({ tokenBudget: null });
    for (const tokenBudget of [undefined, 0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseGoalActionInput({ ...action, tokenBudget })).toThrow();
      if (tokenBudget !== undefined) expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", tokenBudget })).toThrow();
    }
    for (const extra of [{ response: "text" }, { questionId: "q" }, { additionalAutoTurns: 1 }, { surprise: true }])
      expect(() => parseGoalActionInput({ ...action, tokenBudget: 10, ...extra })).toThrow();
    expect(() => parseGoalActionInput({ requestId: "r", expectedRevision: 0, action: "pause", tokenBudget: 10 })).toThrow();
  });
  it("normalizes valid goal input", () => {
    expect(
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "  完成目标  ",
      }),
    ).toEqual({ requestId: "r1", objective: "完成目标" });
  });

  it("rejects empty goals and invalid resume budgets", () => {
    expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: " " })).toThrow();
    expect(() =>
      parseGoalActionInput({
        requestId: "r1",
        expectedRevision: 0,
        action: "resume",
        additionalAutoTurns: 0,
      }),
    ).toThrow();
  });

  it("validates structured goal content instead of casting unknown input", () => {
    for (const value of [null, {}, [{ type: "unknown" }], [{ type: "text", text: 7 }]]) {
      expect(() =>
        parseCreateSessionGoalInput({
          requestId: "r1",
          objective: "完成目标",
          items: value,
        }),
      ).toThrow();
    }
    expect(() =>
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "完成目标",
        attachments: [{ assetId: "" }],
      }),
    ).toThrow();
    expect(
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "完成目标",
        items: [
          {
            type: "context",
            kind: "conversation",
            id: "s1",
            displayName: "说明",
          },
        ],
      }).items?.[0].type,
    ).toBe("context");
  });

  it("binds evidence to the host run and rejects malformed assessments", () => {
    const binding = { goalId: "g1", objectiveVersion: 2, runId: "r1" };
    const assessment = parseGoalAssessment(
      {
        goalId: "forged",
        runId: "forged",
        decision: "complete",
        progress: "verified",
        progressAssessment: { kind: "progress", summary: "已完成" },
        evidence: ["test passed"],
        evidenceRefs: [{ messagePartId: "part1", criterion: "test passes" }],
        progressSignals: [],
        requirements: [
          {
            requirementId: "R1",
            explanation: "tests pass",
            status: "satisfied",
            evidenceRefs: [{ messagePartId: "part1", criterion: "test passes" }],
          },
        ],
        remainingWork: [],
      },
      binding,
    );
    expect(assessment).toMatchObject(binding);
    expect(assessment.evidenceRefs[0]).toMatchObject(binding);
    const waiting = parseGoalAssessment(
      {
        decision: "waiting_user",
        progress: "等待确认",
        progressAssessment: { kind: "waiting", summary: "等待用户" },
        evidence: [],
        requirements: [],
        progressSignals: [],
        question: "选哪个数据源？",
      },
      binding,
    );
    expect(parseGoalAssessment(waiting, binding)).toEqual(waiting);
    for (const decision of ["done", null, 1]) expect(() => parseGoalAssessment({ decision, progress: "work", evidence: [] }, binding)).toThrow();
  });

  it("requires a complete decision to audit every requirement", () => {
    const binding = { goalId: "g1", objectiveVersion: 2, runId: "r1" };
    const complete = {
      decision: "complete",
      progress: "完成实现和验证",
      progressAssessment: { kind: "progress", summary: "完成实现和验证" },
      evidence: ["实现检查通过"],
      evidenceRefs: [{ messagePartId: "part1", criterion: "实现已完成" }],
      progressSignals: [],
      requirements: [
        {
            requirementId: "R1",
            explanation: "实现功能",
          status: "satisfied",
          evidenceRefs: [{ messagePartId: "part1", criterion: "实现已完成" }],
        },
      ],
      remainingWork: [],
    };
    expect(parseGoalAssessment(complete, binding)).toMatchObject({
      requirements: [
        {
          status: "satisfied",
          evidenceRefs: [expect.objectContaining(binding)],
        },
      ],
      remainingWork: [],
    });
    expect(() => parseGoalAssessment({ ...complete, requirements: [] }, binding)).toThrow();
    expect(parseGoalAssessment({ ...complete, remainingWork: ["补文档"] }, binding).remainingWork).toEqual(["补文档"]);
  });

  it("requires a stable blocker key for no-progress assessments", () => {
    const binding = { goalId: "g1", objectiveVersion: 1, runId: "r1" };
    expect(() =>
      parseGoalAssessment(
        {
          decision: "blocked",
          progress: "缺少配置",
          progressAssessment: { kind: "no_progress", summary: "缺少配置" },
          evidence: [],
          requirements: [],
          progressSignals: [],
        },
        binding,
      ),
    ).toThrow();
    expect(
      parseGoalAssessment(
        {
          decision: "blocked",
          progress: "缺少配置",
          progressAssessment: {
            kind: "no_progress",
            summary: "缺少配置",
            blockerKey: "missing-config",
          },
          evidence: [],
          requirements: [],
          progressSignals: [],
        },
        binding,
      ).progressAssessment,
    ).toEqual({
      kind: "no_progress",
      summary: "缺少配置",
      blockerKey: "missing-config",
    });
  });

  it("binds an external wait to the current run", () => {
    const binding = { goalId: "g1", objectiveVersion: 1, runId: "r1" };
    const value = parseGoalAssessment(
      {
        decision: "continue",
        progress: "等待构建",
        progressAssessment: { kind: "waiting", summary: "构建仍在运行" },
        evidence: [],
        requirements: [],
        progressSignals: [],
        wait: {
          kind: "external",
          targetRunId: "run-build",
          ownerRunId: "forged",
          goalId: "forged",
          objectiveVersion: 999,
          deadlineAt: 2_000_000_000_000,
        },
      },
      binding,
    );
    expect(value.wait).toEqual({
      kind: "external",
      targetRunId: "run-build",
      ownerRunId: "r1",
      goalId: "g1",
      objectiveVersion: 1,
      deadlineAt: 2_000_000_000_000,
    });
  });
});
