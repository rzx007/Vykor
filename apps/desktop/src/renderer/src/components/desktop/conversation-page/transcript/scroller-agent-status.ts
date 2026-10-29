import type {
  DesktopSessionPart,
  DesktopSessionMessage,
  DesktopSessionRun,
} from "@shared/session-types"

import { summarizeToolCall, isToolActivityActive } from "../message/models/message-render-model"

export type ScrollerAgentStatusKind =
  "permission" | "tool" | "agent" | "processing" | "generating" | "reasoning"

export type ScrollerAgentStatus = {
  kind: ScrollerAgentStatusKind
  title: string
}

export function resolveScrollerAgentStatus({
  running,
  parts = [],
  messages,
  runs,
  pendingPermissionCount = 0,
  agentTaskRunning = false,
}: {
  running: boolean
  parts?: readonly DesktopSessionPart[]
  messages?: readonly DesktopSessionMessage[]
  runs?: readonly DesktopSessionRun[]
  pendingPermissionCount?: number
  agentTaskRunning?: boolean
}): ScrollerAgentStatus | null {
  if (!running) return null
  if (pendingPermissionCount > 0) return { kind: "permission", title: "等待授权" }

  // 历史任务遗留的 running 片段不代表当前仍在执行。
  const activeRuns =
    runs &&
    new Set(
      runs
        .filter((run) => run.status === "running" || run.status === "pending")
        .map((run) => run.id)
    )
  const activeMessages =
    activeRuns &&
    messages &&
    new Set(
      messages
        .filter((message) => message.runId && activeRuns.has(message.runId))
        .map((message) => message.id)
    )
  const currentParts = activeMessages
    ? parts.filter((part) => activeMessages.has(part.messageId))
    : parts
  const tool = latestInFlightTool(currentParts)
  if (tool) {
    const summary = summarizeToolCall(tool)
    return {
      kind: "tool",
      title: summary.detail ? `${summary.name} · ${summary.detail}` : summary.name,
    }
  }

  if (agentTaskRunning) return { kind: "agent", title: "子智能体运行中" }
  const writing = currentParts
    .filter(
      (part) => (part.type === "text" || part.type === "reasoning") && part.status === "running"
    )
    .at(-1)
  if (writing)
    return writing.type === "text"
      ? { kind: "generating", title: "正在生成回复" }
      : { kind: "reasoning", title: "正在思考" }
  return { kind: "processing", title: "正在处理" }
}

function latestInFlightTool(parts: readonly DesktopSessionPart[]): DesktopSessionPart | undefined {
  const results = new Map(
    parts
      .filter((part) => part.type === "tool_result" && part.toolUseId)
      .map((part) => [part.toolUseId, part])
  )
  return parts.reduce<DesktopSessionPart | undefined>((latest, part) => {
    if (
      part.type !== "tool" ||
      !isToolActivityActive(part, part.toolUseId ? results.get(part.toolUseId) : undefined)
    ) {
      return latest
    }
    if (!latest) return part
    if (part.seq !== latest.seq) return part.seq > latest.seq ? part : latest
    return part.updatedAt > latest.updatedAt ? part : latest
  }, undefined)
}
