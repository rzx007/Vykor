import { describe, expect, it, vi } from "vitest";
import { createGoalUpdateTool } from "../goal-update-tool.js";

describe("GoalUpdate", () => {
  it.each([
    { status: "completed", reason: "已检查当前文件，目标完成" },
    { status: "blocked", reason: "同一阻塞已连续三个 Goal 回合，无法继续" },
    { status: "paused", reason: "用户明确要求暂停" },
    { question: "结果应保存在哪个目录？" },
    { wait: { targetRunId: "child-run", deadlineAt: 12345 } },
  ])("records an optional control request without applying it or emitting an assessment: %j", async input => {
    const submitted: Record<string, unknown>[] = [];
    const emit = vi.fn();
    const tool = createGoalUpdateTool(async update => { submitted.push(update); return { recorded: true }; });
    const result = await tool.execute(input, { cwd: process.cwd(), agent: { emit } as never });
    expect(result.isError).not.toBe(true);
    expect(submitted).toEqual([input]);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("本回合正常结束后生效") });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    {}, { status: "active", reason: "继续" }, { status: "completed" },
    { status: "completed", reason: " " }, { question: "" },
    { question: "choose", status: "completed", reason: "done" },
    { question: "choose", wait: { targetRunId: "child", deadlineAt: 1 } },
    { status: "completed", reason: "done", goalId: "other" },
    { status: "completed", reason: "done", objectiveVersion: 2 },
    { status: "completed", reason: "done", runId: "other" },
    { question: "choose", questionId: "forged" },
    { status: "completed", reason: "done", evidenceRefs: [] },
    { decision: "complete", progress: "done", requirements: [] },
    { wait: { targetRunId: "child", deadlineAt: 0 } },
    { wait: { targetRunId: "child", deadlineAt: 1.5 } },
    { wait: { targetRunId: "child", deadlineAt: Number.MAX_SAFE_INTEGER + 1 } },
    { wait: { targetRunId: " ", deadlineAt: 1 } },
    { wait: { targetRunId: "child", deadlineAt: 1, ownerRunId: "forged" } },
  ])("rejects invalid or extra fields before calling the host: %j", async input => {
    const submit = vi.fn(async () => ({ recorded: true as const }));
    const result = await createGoalUpdateTool(submit).execute(input, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns the host binding or state error without claiming that the goal changed", async () => {
    const tool = createGoalUpdateTool(async () => { throw new Error("goal_run_stale"); });
    const result = await tool.execute({ status: "completed", reason: "done" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("goal_run_stale") });
  });
});
