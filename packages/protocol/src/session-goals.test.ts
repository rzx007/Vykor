import { describe, expect, it } from "vitest";
import { parseCreateSessionGoalInput, parseUpdateSessionGoalInput, parseGoalActionInput, parseGoalUpdateInput } from "./session-goals.js";

describe("session goal protocol", () => {
  it("accepts cancellation of only the queued resume without accepting resume payload fields", () => {
    const action = { requestId: "cancel-queue", expectedRevision: 2, action: "cancel_resume" };
    expect(parseGoalActionInput(action)).toEqual(action);
    expect(() => parseGoalActionInput({ ...action, response: "answer" })).toThrow();
    expect(() => parseGoalActionInput({ ...action, additionalAutoTurns: 2 })).toThrow();
  });
  it("preserves omitted automatic-turn limits and accepts explicit limits", () => {
    expect(parseCreateSessionGoalInput({ requestId: "r", objective: "  完成目标  " })).toEqual({ requestId: "r", objective: "完成目标" });
    expect(parseCreateSessionGoalInput({ requestId: "r", objective: "finish", maxAutoTurns: 0, tokenBudget: 5000 })).toMatchObject({ maxAutoTurns: 0, tokenBudget: 5000 });
    for (const maxAutoTurns of [-1, 1.5, 1001]) expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", maxAutoTurns })).toThrow();
    for (const tokenBudget of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", tokenBudget })).toThrow();
  });
  it("edits only objective and existing content, rejecting removed fields", () => {
    const update = { requestId: "u", expectedRevision: 0, objective: "finish" };
    expect(parseUpdateSessionGoalInput(update)).toEqual(update);
    for (const extra of [{ changeKind: "refine" }, { changeReason: "reason" }, { replaceRequirementIds: [] }, { actor: { kind: "local_user" } }, { tokenBudget: 20 }])
      expect(() => parseUpdateSessionGoalInput({ ...update, ...extra })).toThrow();
  });
  it("accepts three mutually exclusive model updates without model identity", () => {
    for (const input of [
      { status: "completed", reason: "已验证当前结果" },
      { status: "blocked", reason: "连续三轮确认同一阻塞" },
      { status: "paused", reason: "用户要求暂停" },
      { question: "选择哪个数据源？" },
      { wait: { targetRunId: "child", deadlineAt: 2_000_000_000_000 } },
    ]) expect(parseGoalUpdateInput(input)).toEqual(input);
    for (const input of [
      {}, { status: "active", reason: "resume" }, { status: "completed" }, { reason: "alone" },
      { status: "completed", reason: "done", question: "also?" },
      { question: "q", wait: { targetRunId: "r", deadlineAt: 1 } },
      { status: "completed", reason: "done", evidence: [] },
      { question: "q", goalId: "forged" }, { question: "q", runId: "forged" }, { question: "q", objectiveVersion: 2 },
      { wait: { targetRunId: "r", deadlineAt: 1, ownerRunId: "forged" } },
      { wait: { targetRunId: "r", deadlineAt: 0 } }, { wait: { targetRunId: "", deadlineAt: 1 } },
      { status: "completed", reason: " " },
    ]) expect(() => parseGoalUpdateInput(input)).toThrow();
  });
  it("requires versioned question answers and removes confirm and reprepare", () => {
    const resume = { requestId: "a", expectedRevision: 4, action: "resume" };
    expect(parseGoalActionInput({ ...resume, response: "配置已补齐" })).toMatchObject({ response: "配置已补齐" });
    expect(parseGoalActionInput({ ...resume, questionId: "q", objectiveVersion: 1, response: "选 A" })).toMatchObject({ questionId: "q", objectiveVersion: 1 });
    for (const extra of [{ questionId: "q" }, { objectiveVersion: 1 }, { reprepare: true }, { action: "confirm" }, { additionalAutoTurns: 0 }])
      expect(() => parseGoalActionInput({ ...resume, ...extra })).toThrow();
    expect(() => parseGoalActionInput({ ...resume, action: "pause", questionId: "q", objectiveVersion: 1 })).toThrow();
  });
  it("validates budgets without allowing cross-action fields", () => {
    const action = { requestId: "r", expectedRevision: 0, action: "budget" };
    expect(parseGoalActionInput({ ...action, tokenBudget: Number.MAX_SAFE_INTEGER })).toMatchObject({ tokenBudget: Number.MAX_SAFE_INTEGER });
    expect(parseGoalActionInput({ ...action, tokenBudget: null })).toMatchObject({ tokenBudget: null });
    for (const tokenBudget of [undefined, 0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) expect(() => parseGoalActionInput({ ...action, tokenBudget })).toThrow();
    for (const extra of [{ response: "text" }, { questionId: "q" }, { additionalAutoTurns: 1 }, { surprise: true }]) expect(() => parseGoalActionInput({ ...action, tokenBudget: 10, ...extra })).toThrow();
    expect(() => parseGoalActionInput({ ...action, action: "pause", tokenBudget: 10 })).toThrow();
  });
  it("validates structured goal content", () => {
    for (const items of [null, {}, [{ type: "unknown" }], [{ type: "text", text: 7 }]]) expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", items })).toThrow();
    expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: "finish", attachments: [{ assetId: "" }] })).toThrow();
    expect(parseCreateSessionGoalInput({ requestId: "r", objective: "finish", items: [{ type: "context", kind: "conversation", id: "s1", displayName: "说明" }] }).items?.[0].type).toBe("context");
    expect(() => parseCreateSessionGoalInput({ requestId: "r", objective: " " })).toThrow();
  });
});
