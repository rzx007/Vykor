import type { SessionGoal } from "@shared/session-types"

const labels: Record<NonNullable<SessionGoal["stopReason"]>["code"], string> = {
  user_paused: "你已暂停目标",
  user_cancelled: "你已取消目标",
  updating_objective: "正在更新目标",
  auto_turn_limit: "自动续跑次数已用完",
  run_error: "目标运行失败",
  wait_invalid: "等待任务无效",
  wait_timeout: "等待任务超时",
  external_failed: "外部任务失败",
  no_progress: "连续多轮没有进展",
  startup_recovery: "重启后等待继续",
  token_budget: "Token 预算已用完",
  usage_unknown: "无法确认用量",
  provider_limit: "服务商限制了运行",
}

export function goalStopReasonLabel(goal: SessionGoal): string | undefined {
  return goal.stopReason ? labels[goal.stopReason.code] : undefined
}
