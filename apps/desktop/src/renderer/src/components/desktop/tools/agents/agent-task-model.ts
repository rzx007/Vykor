import type { DesktopAuxSessionUpdate, DesktopSessionTask } from "@shared/session-types"

export function agentTaskStatusLabel(status: DesktopSessionTask["status"]): string {
  return {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "执行出错",
    stopped: "已停止",
    interrupted: "已中断",
  }[status]
}

export interface AgentTaskPresentation {
  label: string
  tone: "neutral" | "warning" | "error"
  reason?: string
  hasPartialReport: boolean
}

export function agentTaskPresentation(task: DesktopSessionTask): AgentTaskPresentation {
  const label = agentTaskStatusLabel(task.status)
  if (task.status !== "failed" && task.status !== "interrupted") {
    return { label, tone: "neutral", hasPartialReport: false }
  }
  const failure = task.metadata?.childFailure
  const child = task.type === "agent" && Boolean(task.childSessionId && task.runId)
  const detail = child && isRecord(failure) ? failure : undefined
  const report = detail?.partialResult
  const hasPartialReport = isRecord(report) && report.version === 1 &&
    report.childSessionId === task.childSessionId && report.runId === task.runId &&
    (report.source === "committed_assistant_text" || report.source === "limit_finalization") &&
    typeof report.text === "string" && report.text.trim().length > 0 && typeof report.truncated === "boolean"
  const budget = task.status === "failed" &&
    (detail?.failureKind === "max_turns" || detail?.failureKind === "timeout")
  const reason = budget
    ? detail?.failureKind === "max_turns" ? "本次轮次已用完，子任务未完成。" : "本次执行时间已用完，子任务未完成。"
    : task.status === "interrupted" ? "本次子任务已中断。" : "本次子任务执行出错。"
  return {
    label: budget ? `未完成 · 已达${detail?.failureKind === "max_turns" ? "轮次" : "时间"}上限` : label,
    tone: budget ? "warning" : "error",
    reason: reason + (hasPartialReport ? " 已保留部分结果，可打开子会话查看。" : ""),
    hasPartialReport,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface AgentTaskGroups {
  active: DesktopSessionTask[]
  completed: DesktopSessionTask[]
}

export function groupAgentTasks(tasks: DesktopSessionTask[]): AgentTaskGroups {
  const active: DesktopSessionTask[] = []
  const completed: DesktopSessionTask[] = []
  for (const task of tasks) {
    if (task.type !== "agent" || !task.childSessionId) continue
    if (task.status === "pending" || task.status === "running") active.push(task)
    else completed.push(task)
  }
  const newestFirst = (left: DesktopSessionTask, right: DesktopSessionTask): number =>
    right.createdAt - left.createdAt
  return { active: active.sort(newestFirst), completed: completed.sort(newestFirst) }
}

export function matchesAgentSessionUpdate(
  expectedSubscriptionId: string,
  expectedSessionId: string | null,
  update: DesktopAuxSessionUpdate
): boolean {
  const sessionId =
    update.update.kind === "snapshot"
      ? update.update.view.session.id
      : update.update.sessionId
  return Boolean(
    expectedSessionId &&
    update.subscriptionId === expectedSubscriptionId &&
    sessionId === expectedSessionId
  )
}
