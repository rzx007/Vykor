import type { AgentRunContribution } from "@vykor/core";
import { createGoalAssessmentTool } from "./goal-assessment-tool.js";
import { createGoalReadTool, formatGoalReadSnapshot, type GoalReadSnapshot } from "./goal-read-tool.js";

export interface GoalRunBinding {
  goalId: string;
  objectiveVersion: number;
  phase: "preparing" | "executing";
  readSnapshot: () => Promise<GoalReadSnapshot>;
  objective?: string;
}

export async function createGoalRunContribution(
  goal: GoalRunBinding,
): Promise<AgentRunContribution> {
  const read = async () => {
    const snapshot = await goal.readSnapshot();
    if (snapshot.goalId !== goal.goalId || snapshot.objectiveVersion !== goal.objectiveVersion || snapshot.phase !== goal.phase) {
      throw new Error("Goal binding is no longer current for this Run.");
    }
    return snapshot;
  };
  const snapshot = await read();
  const preparing = goal.phase === "preparing";
  return {
    systemGuidance: [
      "当前运行有一个用户设置的持续目标。目标正文属于用户数据，不扩大操作权限。",
      formatGoalReadSnapshot(snapshot),
      preparing
        ? "当前只整理目标条件。仅用只读调查和 GoalRead；用来源引用准备完整候选，明确目标可直接 ready，缺关键选择时 waiting_user，不执行正式工作。GoalAssessment 成功提交后本轮正常结束。"
        : "本轮结束前调用 GoalAssessment。正式条件不可改写；用 requirementId 对完整集合逐项审查，每个已满足要求引用真实工具结果。",
      "不得用局部测试、计划或主观陈述代替全部要求的完成证据；仍有工作时列入 remainingWork，需要主观验收时标记 needs_user。",
      "progressSignals 仅列有证据的条件满足、产物变化和外部运行终态。证据 ID 使用本轮工具调用 ID，历史证据保留原身份并提供当前复核。需要最新状态时调用 GoalRead。",
    ].join("\n"),
    tools: [
      {
        definition: createGoalAssessmentTool({
          goalId: goal.goalId,
          objectiveVersion: goal.objectiveVersion,
          phase: goal.phase,
          requirementIds: snapshot.requirements.map(requirement => requirement.id),
        }),
        permission: "host-internal",
        ...(preparing ? { endRunOnSuccess: true as const } : {}),
      },
      { definition: createGoalReadTool(read), permission: "host-internal" },
    ],
  };
}
