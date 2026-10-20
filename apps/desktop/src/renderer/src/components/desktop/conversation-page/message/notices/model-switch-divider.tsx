import { ArrowRightLeft } from "lucide-react"

export interface ModelSwitchPresentation {
  kind: "model_switch"
  fromModel: string
  toModel: string
}

export function readModelSwitchPresentation(
  metadata: Record<string, unknown>
): ModelSwitchPresentation | null {
  const presentation = metadata.presentation
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null
  const value = presentation as Record<string, unknown>
  if (value.kind !== "model_switch") return null
  if (typeof value.fromModel !== "string" || !value.fromModel.trim()) return null
  if (typeof value.toModel !== "string" || !value.toModel.trim()) return null
  return {
    kind: "model_switch",
    fromModel: value.fromModel.trim(),
    toModel: value.toModel.trim(),
  }
}

export function ModelSwitchDivider({
  presentation,
}: {
  presentation: ModelSwitchPresentation
}): React.JSX.Element {
  const label = `模型已切换 ${presentation.fromModel} 到 ${presentation.toModel}`
  return (
    <div
      role="separator"
      aria-label={label}
      className="text-ui-caption flex w-full items-center gap-3 py-3 text-ui-muted"
    >
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border/70" />
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <ArrowRightLeft aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
        <span>模型已切换</span>
        <span>{presentation.fromModel}</span>
        <span aria-hidden="true">→</span>
        <span>{presentation.toModel}</span>
      </span>
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border/70" />
    </div>
  )
}
