import { buildAssistantContent, toolCallStatus } from "../message/message-render-model"
import { agentJobId, toolOutputText } from "../message/message-content"
import type { DesktopSessionTask } from "@shared/session-types"
import type { TurnBlockPlanItem } from "./turn-block-plan"

export type TurnProcessPlan = { process: TurnBlockPlanItem[]; answer: TurnBlockPlanItem[] }

/** 仅折叠明确的过程前缀；未知阶段和交互产物保持原始展示。 */
export function splitTurnProcess(
  plan: TurnBlockPlanItem[],
  tasks: readonly DesktopSessionTask[] = []
): TurnProcessPlan | null {
  const parts = plan.filter((item) => item.kind === "assistant").flatMap((item) => item.parts)
  const final = parts.find(
    (part) => part.type === "text" && part.metadata.phase === "final_answer" && part.text?.trim()
  )
  if (!final) return null
  const finalIndex = parts.indexOf(final)
  if (finalIndex === 0) return null
  if (buildAssistantContent(parts.slice(0, finalIndex)).length === 0) return null
  if (
    parts
      .slice(finalIndex)
      .some(
        (part) =>
          part.type !== "error" && (part.type !== "text" || part.metadata.phase !== "final_answer")
      )
  )
    return null
  const results = new Map(
    parts
      .filter((part) => part.type === "tool_result" && part.toolUseId)
      .map((part) => [part.toolUseId!, part])
  )
  if (
    parts.some((part) => {
      if (part.metadata.pluginUi) return true
      const status =
        part.type === "tool"
          ? toolCallStatus(part, part.toolUseId ? results.get(part.toolUseId) : undefined)
          : part.status
      if (status === "pending" || status === "running") return true
      if (!["text", "reasoning", "tool", "tool_result", "error"].includes(part.type)) return true
      if (
        part.type === "text" &&
        part.text?.trim() &&
        part.metadata.phase !== "commentary" &&
        part.metadata.phase !== "final_answer"
      )
        return true
      let output = part.output
      if (typeof output === "string") {
        try {
          output = JSON.parse(output)
        } catch {
          /* 普通工具文本。 */
        }
      }
      for (const value of [part.metadata, part.metadata.toolProgress, output]) {
        if (!value || typeof value !== "object") continue
        const facts = value as Record<string, unknown>
        if (facts.kind === "terminal" || facts.phase === "waiting_permission") return true
      }
      return false
    })
  )
    return null
  // 已结束的子任务属于过程；派出成功不等于子任务完成，必须按任务 ID 核对状态。
  if (
    buildAssistantContent(parts).some((unit) => {
      if (unit.type === "agent") {
        const id = agentJobId(
          toolOutputText(unit.result?.output ?? unit.result?.text ?? unit.call.output) ?? ""
        )
        if (!id) return toolCallStatus(unit.call, unit.result) === "completed"
        const task = tasks.find((task) => task.type === "agent" && task.id === id)
        return !task || task.status === "pending" || task.status === "running"
      }
      return !["markdown", "reasoning", "tool", "error"].includes(unit.type)
    })
  )
    return null
  if (plan.some((item) => item.kind === "divider" && item.phase === "started")) return null

  const process: TurnBlockPlanItem[] = [],
    answer: TurnBlockPlanItem[] = []
  let reachedFinal = false
  for (const item of plan) {
    const index = item.parts.findIndex((part) => part.id === final.id)
    if (item.kind === "assistant" && index >= 0) {
      if (index > 0)
        process.push({
          ...item,
          key: `${item.key}-process`,
          messageId: `${item.messageId}-process`,
          parts: item.parts.slice(0, index),
          showActions: false,
        })
      answer.push({ ...item, parts: item.parts.slice(index), summaryParts: parts })
      reachedFinal = true
    } else if (reachedFinal) answer.push(item)
    else
      process.push({
        ...item,
        key: `${item.key}-process`,
        messageId: `${item.messageId}-process`,
        showActions: false,
      })
  }
  return process.length ? { process, answer } : null
}
