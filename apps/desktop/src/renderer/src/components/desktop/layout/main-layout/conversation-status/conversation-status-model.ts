import type {
  DesktopSessionPart,
  DesktopSessionRun,
  DesktopSessionView,
} from "@shared/session-types"
import { isAskUserPermission } from "@renderer/components/desktop/conversation-page/message/ask-user-payload"
import {
  buildAssistantContent,
  isToolActivityActive,
  summarizeToolCall,
} from "@renderer/components/desktop/conversation-page/message/message-render-model"
import {
  taskTiming,
  type TaskTiming,
} from "@renderer/components/desktop/conversation-page/message/task-timing"

export type ConversationStatusKind =
  | "processing"
  | "queued"
  | "permission"
  | "question"
  | "completed"
  | "interrupted"
  | "failed"
  | "reconnecting"

export interface ConversationStatusModel {
  key: string
  kind: ConversationStatusKind
  label: string
  summary: string
  timing?: TaskTiming
  canStop: boolean
  dismissible: boolean
}

const labels: Record<ConversationStatusKind, string> = {
  processing: "处理中",
  queued: "等待执行",
  permission: "等待授权",
  question: "等待回答",
  completed: "已完成",
  interrupted: "已停止",
  failed: "需要处理",
  reconnecting: "正在重连",
}

export function resolveConversationStatus(
  view: DesktopSessionView | null,
  sessionId: string | null
): ConversationStatusModel | null {
  if (!view || !sessionId || view.session.id !== sessionId || view.session.status === "archived")
    return null
  const permission = view.permissions.find((item) => item.status === "pending")
  const orderedRuns = [...view.runs].sort((left, right) => left.createdAt - right.createdAt)
  const run =
    (permission?.runId ? orderedRuns.find((item) => item.id === permission.runId) : undefined) ??
    orderedRuns.findLast((item) => item.status === "running") ??
    orderedRuns.find((item) => item.status === "pending") ??
    orderedRuns.at(-1)
  if (!run && !permission) return null

  const kind: ConversationStatusKind = permission
    ? isAskUserPermission(permission)
      ? "question"
      : "permission"
    : view.syncStatus === "reconnecting"
      ? "reconnecting"
      : run!.status === "running"
        ? "processing"
        : run!.status === "pending"
          ? "queued"
          : run!.status
  const timing = run
    ? taskTiming(
        view.runs.filter((item) =>
          run.inputId ? item.inputId === run.inputId : item.id === run.id
        )
      )
    : undefined
  let summary = run ? currentRunSummary(view, run) : ""
  if (kind === "permission") summary = "点击返回聊天处理授权请求"
  if (kind === "question") summary = "点击返回聊天回答问题"
  if (kind === "reconnecting") summary = "连接恢复后继续更新进度"
  if (kind === "failed") summary = "点击返回聊天查看详情"

  return {
    key: `${sessionId}:${run?.id ?? permission!.id}`,
    kind,
    label: labels[kind],
    summary: compactText(summary) || "点击返回聊天",
    timing,
    canStop: run?.status === "running" && view.syncStatus === "connected",
    dismissible: ["completed", "interrupted", "failed"].includes(kind),
  }
}

function currentRunSummary(view: DesktopSessionView, run: DesktopSessionRun): string {
  // 排队输入和旧轮次不参与动作摘要；同一输入的其他运行只参与耗时计算。
  const messages = view.messages.filter(
    (message) =>
      message.role === "assistant" &&
      (message.runId
        ? message.runId === run.id
        : Boolean(run.inputId && message.inputId === run.inputId))
  )
  const partsByMessage = new Map(
    messages.map((message) => [message.id, [] as DesktopSessionPart[]])
  )
  for (const part of view.parts) partsByMessage.get(part.messageId)?.push(part)
  messages.sort((left, right) => left.seq - right.seq)
  const parts = messages.flatMap((message) =>
    partsByMessage.get(message.id)!.sort((left, right) => left.seq - right.seq)
  )
  // 工具结果可跨消息返回，配对时保留整个运行的范围。
  const units = buildAssistantContent(parts).reverse()
  if (run.status === "running") {
    const tool = units.find(
      (unit) =>
        (unit.type === "tool" || unit.type === "agent") &&
        isToolActivityActive(unit.call, unit.result)
    )
    if (tool && (tool.type === "tool" || tool.type === "agent")) {
      const summary = summarizeToolCall(tool.call)
      return summary.detail ? `${summary.name} · ${summary.detail}` : summary.name
    }
    if (
      view.tasks.some(
        (task) =>
          task.runId === run.id &&
          task.type === "agent" &&
          ["pending", "running"].includes(task.status)
      )
    )
      return "子智能体运行中"
  }
  // 文本摘要保留消息边界，不能把前一段进度与最终回复拼起来。
  const latestReply = messages.findLast((message) =>
    partsByMessage.get(message.id)!.some((part) => part.type === "text" && part.text?.trim())
  )
  const reply = latestReply
    ? buildAssistantContent(partsByMessage.get(latestReply.id)!)
        .reverse()
        .find((unit) => unit.type === "markdown" && unit.text.trim())
    : undefined
  if (reply?.type === "markdown") return reply.text
  return view.inputs.find((input) => input.id === run.inputId)?.content ?? ""
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 240 ? `${normalized.slice(0, 240).trimEnd()}…` : normalized
}
