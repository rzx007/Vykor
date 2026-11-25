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
    typeof run.metadata.pluginId !== "string" ||
    Array.isArray(run.metadata.toolGeneration)
  )
    return undefined
  // 已有助手输出或子任务的历史运行也已完成准备。
  const assistantMessageIds = new Set(
    messages
      .filter((item) => item.runId === run.id && item.role === "assistant")
      .map((item) => item.id)
  )
  if (
    parts.some((part) => assistantMessageIds.has(part.messageId)) ||
    tasks.some((task) => task.runId === run.id)
  )
    return undefined
  const reference = inputs
    .find((input) => input.id === run.inputId)
    ?.items.find((item) => item.type === "capability" && item.pluginId === run.metadata.pluginId)
  return reference?.type === "capability" ? `正在准备 ${reference.displayName}…` : "正在准备插件…"
}
