import type { DesktopSessionPart } from "@shared/session-types"

import { summarizeToolCall } from "../message/models/message-render-model"

export type ScrollerAgentStatusKind = "permission" | "tool" | "agent" | "processing"

export type ScrollerAgentStatus = {
  kind: ScrollerAgentStatusKind
  title: string
}

export function resolveScrollerAgentStatus({
  running,
  parts = [],
  pendingPermissionCount = 0,
  agentTaskRunning = false,
}: {
  running: boolean
  parts?: readonly DesktopSessionPart[]
  pendingPermissionCount?: number
  agentTaskRunning?: boolean
}): ScrollerAgentStatus | null {
  if (!running) return null
  if (pendingPermissionCount > 0) return { kind: "permission", title: "等待授权" }

  const tool = latestInFlightTool(parts)
  if (tool) {
    const summary = summarizeToolCall(tool)
    return {
      kind: "tool",
      title: summary.detail ? `${summary.name} · ${summary.detail}` : summary.name,
    }
  }

  if (agentTaskRunning) return { kind: "agent", title: "子智能体运行中" }
  return { kind: "processing", title: "正在处理" }
}

function latestInFlightTool(parts: readonly DesktopSessionPart[]): DesktopSessionPart | undefined {
  return parts.reduce<DesktopSessionPart | undefined>((latest, part) => {
    if (part.type !== "tool" || (part.status !== "pending" && part.status !== "running")) {
      return latest
    }
    if (!latest) return part
    if (part.seq !== latest.seq) return part.seq > latest.seq ? part : latest
    return part.updatedAt > latest.updatedAt ? part : latest
  }, undefined)
}
