import { describe, expect, it, vi } from "vitest";
import { createGoalAssessmentTool } from "./goal-assessment-tool.js";

describe("GoalAssessment tool", () => {
  it.each(["messagePartIds", "dependencies"] as const)("rejects duplicate revalidation %s", field => {
    const emit = vi.fn();
    const dependency = { subjectKey: "subject", digest: "missing" };
    const revalidation = { messagePartIds: ["current"], environmentKey: "env", dependencies: [dependency] };
    if (field === "messagePartIds") revalidation.messagePartIds.push("current");
    else revalidation.dependencies.push(dependency);
    const input = { decision: "continue", progress: "调查", evidence: [], progressSignals: [],
      progressAssessment: { kind: "progress", summary: "调查" }, requirements: [{ requirementId: "R1",
        status: "incomplete", explanation: "调查", evidenceRefs: [{ messagePartId: "old", criterion: "check", revalidation }] }] };
    const tool = createGoalAssessmentTool({ goalId: "g", objectiveVersion: 2, phase: "executing", requirementIds: ["R1"] });
    return tool.execute(input, { cwd: process.cwd(), agent: { emit, scope: { runId: "r" } } as never }).then(result => {
      expect(result.isError).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });
  });
  it.each(["missing", "unknown", "duplicate", "prepare", "host_progress", "partial_origin"] as const)("rejects an invalid executing audit: %s", async mode => {
    const emit = vi.fn();
    const requirements = ["R1", "R2"].map(requirementId => ({ requirementId, status: "incomplete", explanation: "待完成", evidenceRefs: [] as unknown[] }));
    const input: Record<string, unknown> = { decision: "continue", progress: "进行中", evidence: [],
      progressAssessment: { kind: "progress", summary: "调查中" }, requirements, progressSignals: [] };
    if (mode === "missing") requirements.pop();
    if (mode === "unknown") requirements[1]!.requirementId = "R3";
    if (mode === "duplicate") requirements[1]!.requirementId = "R1";
    if (mode === "prepare") input.preparedRequirements = [];
    if (mode === "host_progress") input.hostProgress = {};
    if (mode === "partial_origin") requirements[0]!.evidenceRefs = [{ messagePartId: "p", criterion: "check", goalId: "g" }];
    const tool = createGoalAssessmentTool({ goalId: "g", objectiveVersion: 1, phase: "executing", requirementIds: ["R1", "R2"] });
    expect((await tool.execute(input, { cwd: process.cwd(), agent: { emit, scope: { runId: "r" } } as never })).isError).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });
  it("accepts ready candidates only for preparing and forbids completion there", async () => {
    const emit = vi.fn();
    const input = { decision: "ready", progress: "整理完成", evidence: [],
      progressAssessment: { kind: "progress", summary: "条件来自用户" },
      preparedRequirements: [{ text: "修复错误", source: [{ kind: "input", inputId: "i", quote: "修复错误" }],
        verification: { kind: "check", method: "test", environment: "local", expected: "pass" }, constraints: [] }] };
    const preparing = createGoalAssessmentTool({ goalId: "g", objectiveVersion: 1, phase: "preparing" } as never);
    expect((await preparing.execute(input, { cwd: process.cwd(), agent: { emit, scope: { runId: "r" } } as never })).isError).not.toBe(true);
    expect((await preparing.execute({ ...input, decision: "complete" }, { cwd: process.cwd(), agent: { emit, scope: { runId: "r" } } as never })).isError).toBe(true);
    const executing = createGoalAssessmentTool({ goalId: "g", objectiveVersion: 1, phase: "executing" } as never);
    expect((await executing.execute(input, { cwd: process.cwd(), agent: { emit, scope: { runId: "r" } } as never })).isError).toBe(true);
  });
  it("binds external waits to the host objective and owner Run", async () => {
    const emit = vi.fn(async () => undefined);
    const result = await createGoalAssessmentTool({ goalId: "g", objectiveVersion: 2, phase: "executing" }).execute({
      decision: "continue", progress: "waiting", evidence: [],
      progressAssessment: { kind: "waiting", summary: "waiting for build" },
      wait: { kind: "external", targetRunId: "child-run", deadlineAt: 2000000000000 },
      requirements: [{ requirementId: "R1", status: "incomplete", evidenceRefs: [], explanation: "等待构建" }],
      progressSignals: [],
    }, { cwd: process.cwd(), agent: { emit, scope: { runId: "owner" } } as never });
    expect(result.isError).not.toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      payload: expect.objectContaining({ goalId: "g", objectiveVersion: 2, runId: "owner",
        wait: { kind: "external", targetRunId: "child-run", deadlineAt: 2000000000000, ownerRunId: "owner", goalId: "g", objectiveVersion: 2 } }),
    }) }));
  });
  it("emits a structured domain assessment", async () => {
    const emit = vi.fn(async () => undefined);
    const result = await createGoalAssessmentTool({
      goalId: "g1",
      objectiveVersion: 2,
      phase: "executing",
    }).execute(
      {
        decision: "continue",
        progress: "完成协议",
        progressAssessment: { kind: "progress", summary: "协议已完成" },
        evidence: ["protocol tests passed"],
        nextStep: "实现 UI",
        requirements: [{ requirementId: "R1", status: "incomplete", evidenceRefs: [], explanation: "UI尚未完成" }],
        progressSignals: [],
      },
      {
        cwd: process.cwd(),
        sessionId: "s1",
        agent: { emit, scope: { runId: "r1" } } as never,
      },
    );
    expect(result.isError).not.toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "domain.event",
        data: expect.objectContaining({
          name: "goal.assessment",
          payload: expect.objectContaining({
            goalId: "g1",
            objectiveVersion: 2,
            runId: "r1",
          }),
        }),
      }),
    );
  });

  it("rejects an unbound run even when model input claims a goal", async () => {
    const emit = vi.fn();
    const result = await createGoalAssessmentTool().execute(
      {
        goalId: "forged",
        decision: "complete",
        progress: "done",
        progressAssessment: { kind: "progress", summary: "done" },
        evidence: ["done"],
      },
      { cwd: process.cwd(), agent: { emit } as never },
    );
    expect(result.isError).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects completion without a requirement audit", async () => {
    const emit = vi.fn();
    const result = await createGoalAssessmentTool({
      goalId: "g1",
      objectiveVersion: 1,
      phase: "executing",
    }).execute(
      {
        decision: "complete",
        progress: "done",
        progressAssessment: { kind: "progress", summary: "done" },
        evidence: ["done"],
        evidenceRefs: [],
      },
      { cwd: process.cwd(), agent: { emit, scope: { runId: "r1" } } as never },
    );
    expect(result.isError).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });
});
