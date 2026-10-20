export type ContextCompactionPhase = "started" | "completed" | "failed" | "interrupted"

export interface ContextCompactionPresentation {
  kind: "context_compaction"
  phase: ContextCompactionPhase
}

export function readContextCompactionPresentation(
  metadata: Record<string, unknown>
): ContextCompactionPresentation | null {
  const presentation = metadata.presentation
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null
  const value = presentation as Record<string, unknown>
  if (value.kind !== "context_compaction") return null
  if (
    value.phase !== "started" &&
    value.phase !== "completed" &&
    value.phase !== "failed" &&
    value.phase !== "interrupted"
  ) {
    return null
  }
  return { kind: "context_compaction", phase: value.phase }
}

export function compactionDividerLabel(phase: ContextCompactionPhase): string {
  if (phase === "started") return "正在压缩上下文"
  if (phase === "completed") return "已压缩上下文"
  if (phase === "failed") return "上下文压缩失败"
  return "上下文压缩已中断"
}
