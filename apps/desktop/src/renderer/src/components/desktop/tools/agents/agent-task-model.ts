import type { DesktopAuxSessionUpdate, DesktopSessionTask } from "@shared/session-types"

export function agentTaskStatusLabel(status: DesktopSessionTask["status"]): string {
  return {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    interrupted: "已中断",
  }[status]
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
