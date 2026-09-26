import { readSessionModelUsage } from "@vykor/client"

export function ModelUsageNotice({ metadata }: { metadata: Record<string, unknown> }): React.JSX.Element | null {
  if (!readSessionModelUsage(metadata)?.incomplete) return null
  const usage = metadata.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
  const known = typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number"
    ? `已知用量：${usage.inputTokens} 输入 / ${usage.outputTokens} 输出；`
    : ""
  return <div className="text-xs text-ui-muted" role="note">{known}部分请求用量未知，非完整总消耗。</div>
}
