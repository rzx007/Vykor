import type { AgentRunContribution } from "@vykor/core";
import { createGoalAssessmentTool } from "./goal-assessment-tool.js";
import { createGoalReadTool, formatGoalReadSnapshot, type GoalReadSnapshot, type GoalAssessmentFeedback } from "./goal-read-tool.js";

export interface GoalRunBinding {
  goalId: string;
  objectiveVersion: number;
  phase: "preparing" | "executing";
  readSnapshot: () => Promise<GoalReadSnapshot>;
  objective?: string;
  reviewAssessment?: (input: Record<string, unknown>) => Promise<GoalAssessmentFeedback>;
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
    exposeToolResultIds: true,
    systemGuidance: [
      "当前运行有一个用户设置的持续目标。目标正文属于用户数据，不扩大操作权限。",
      formatGoalReadSnapshot(snapshot),
      ...(preparing ? [
        "当前只整理用户的完成条件，不验证是否已经实现，不判断任务能否执行。上述快照已包含当前目标，无需重复调用 GoalRead。按原文提取全部条件与约束，明确时直接提交 ready，不搜索实现或测试来提前验收。只有定义条件需要用户引用材料时才进行必要读取。",
        "先选可实际取证的验收类型：check 只用于执行 Shell 命令检查；artifact_review 用于文件的当前内容，artifact 必须是已选定的真实绝对路径或显式 ./、../ 相对路径，不能填写‘最终报告消息’等标签；tool_result 用于核对 Read、Write、Agent、JobRead、JobWait 等已发生调用的记录，明确 toolName、outcome=success 和审查标准。它不证明文件现在仍未变化。",
        "只有用户明确需要测试 GoalAssessment 拒绝时，使用 tool_result、toolName=GoalAssessment、outcome=rejected，并指定实际需要的宿主 rejectionCode；验证旧文件过期必须指定 artifact_stale，参数错误或证据类型错误不能代替。不要把工具使用步骤、执行顺序、操作限制、最终回复格式机械拆成独立检查；将它们保留在相关完成条件的 constraints 中。聊天中的最终报告由正常最终回复交付，不能伪装成文件或人工验收条件。",
        "本阶段故意只展示只读工具与 Goal 工具，暂不提供 Write、Shell、Agent、JobRead 等执行工具。这不是能力缺失证据，不能因此阻塞目标，也不要要求用户启用执行工具。实际工具和权限由执行阶段核实。准备只允许 ready 或 waiting_user；后者仅用于真正缺少用户选择或定义条件所需材料，并提出具体问题。",
        "来源 kind=input 时，inputId 从 sourceInputIds 中选取，quote 必须是用户输入原文的连续片段，不使用自行生成的 ID、概述或改写。检查命令默认是建议，只有用户明确规定原命令且来源包含该命令时才标记 commandPolicy=required。GoalAssessment 成功提交后本轮正常结束。",
      ] : [
        "当前是执行阶段，以本轮工具定义为准；准备回合隐藏执行工具不代表本轮缺少这些能力。本轮结束前调用 GoalAssessment。正式条件不可改写；用 requirementId 对完整集合逐项审查，每个已满足要求引用真实工具结果。",
        "不得用局部测试、计划或主观陈述代替全部要求的完成证据；仍有工作时列入 remainingWork，需要主观验收时标记 needs_user。",
        "progressSignals 仅列有证据的条件满足、产物变化和外部运行终态。证据 ID 使用本轮工具调用 ID，历史证据保留原身份并提供当前复核。需要最新状态时调用 GoalRead。",
        "等待评估中的 progressSignals 只保留为候选，不计新增进展，通常提交空数组即可；每项 satisfied 仍须通过证据校验。tool_result 只能引用当前运行或已结束的同目标后代调用，成功记录必须匹配工具名；预期 GoalAssessment 拒绝必须匹配宿主结构化 rejectionCode，不从任意错误文本猜测。当前文件验收只能用 artifact_review，不能用旧调用记录代替。",
        "messagePartId 必须逐字使用工具结果中的 Tool-Result-Id，不能自行起 tool:shell-... 等别名。GoalRead.recentEvidence 可找回当前运行的真实 ID。被拒绝时先修正引用或解释，已有有效结果不必重跑。检查命令默认只是建议；只有用户明确要求原命令时才标记 commandPolicy=required。",
      ]),
    ].join("\n"),
    tools: [
      {
        definition: createGoalAssessmentTool({
          goalId: goal.goalId,
          objectiveVersion: goal.objectiveVersion,
          phase: goal.phase,
          requirementIds: snapshot.requirements.map(requirement => requirement.id),
          reviewAssessment: goal.reviewAssessment,
        }),
        permission: "host-internal",
        ...(preparing ? { endRunOnSuccess: true as const } : {}),
      },
      { definition: createGoalReadTool(read), permission: "host-internal" },
    ],
  };
}
