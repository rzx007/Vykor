import type { DesktopSessionView } from "@shared/session-types"

export function PluginPreparationStatus({ activeSessionId, view }: {
  activeSessionId: string | null
  view: DesktopSessionView | null
}): React.JSX.Element | null {
  if (!activeSessionId || view?.session.id !== activeSessionId) return null
  const run = view.runs.find((item) => item.status === "running" && typeof item.metadata.pluginId === "string")
  if (!run) return null
  const messageIds = new Set(view.messages.filter((item) => item.runId === run.id).map((item) => item.id))
  if (view.parts.some((part) => messageIds.has(part.messageId)) || view.tasks.some((task) => task.runId === run.id)) return null
  const reference = view.inputs.find((input) => input.id === run.inputId)?.items.find((item) => item.type === "capability" && item.pluginId === run.metadata.pluginId)
  const displayName = reference?.type === "capability" ? reference.displayName : "插件"
  return <p role="status" aria-live="polite" data-session-id={activeSessionId} data-run-id={run.id} data-plugin-id={run.metadata.pluginId as string} className="px-4 py-2 text-sm text-muted-foreground">正在准备 {displayName}…</p>
}
