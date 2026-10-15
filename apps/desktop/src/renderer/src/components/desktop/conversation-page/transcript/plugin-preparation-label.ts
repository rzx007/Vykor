import type { DesktopSessionRun, DesktopSessionView } from "@shared/session-types"

export function pluginPreparationLabel(
  run: DesktopSessionRun | undefined,
  {
    messages,
    parts,
    inputs,
    tasks,
  }: Pick<DesktopSessionView, "messages" | "parts" | "inputs" | "tasks">
): string | undefined {
  if (
    !run ||
    (run.status !== "pending" && run.status !== "running") ||
    typeof run.metadata.pluginId !== "string"
  )
    return undefined
  // 用户消息不会结束准备；助手输出、工具生成进度或子任务才表示准备完成。
  const assistantMessageIds = new Set(
    messages
      .filter((item) => item.runId === run.id && item.role === "assistant")
      .map((item) => item.id)
  )
  if (
    parts.some((part) => assistantMessageIds.has(part.messageId)) ||
    tasks.some((task) => task.runId === run.id) ||
    (Array.isArray(run.metadata.toolGeneration) && run.metadata.toolGeneration.length > 0)
  )
    return undefined
  const reference = inputs
    .find((input) => input.id === run.inputId)
    ?.items.find((item) => item.type === "capability" && item.pluginId === run.metadata.pluginId)
  return reference?.type === "capability" ? `正在准备 ${reference.displayName}…` : "正在准备插件…"
}
