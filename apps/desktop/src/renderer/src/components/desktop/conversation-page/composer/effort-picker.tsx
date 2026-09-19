import { ChevronDown, Gauge } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import type { DesktopModel } from "@shared/session-types"
import { PickerMenuItem } from "./controls"

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  default: "默认",
}

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value
}

export function resolveEffortTiers(
  models: DesktopModel[],
  selectedModel: string | null,
  selectedProvider: string | null
): string[] {
  const model =
    models.find((item) => item.id === selectedModel && item.providerName === selectedProvider) ??
    models.find((item) => item.id === selectedModel)
  return model?.reasoningEfforts ?? []
}

export function EffortPicker({
  open,
  onOpenChange,
  tiers,
  value,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tiers: string[]
  value: string | null
  onSelect: (effort: string) => void
}): React.JSX.Element | null {
  if (tiers.length === 0) return null
  const label = value && tiers.includes(value) ? effortLabel(value) : "默认"
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            aria-label="推理强度"
            className="h-8 max-w-32 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground"
          />
        }
      >
        <Gauge data-icon="inline-start" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        side="top"
        align="end"
        sideOffset={8}
        className="w-44 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
      >
        <PickerMenuItem selected={!value || !tiers.includes(value)} onClick={() => onSelect("")}>
          <span>默认</span>
        </PickerMenuItem>
        {tiers.map((tier) => (
          <PickerMenuItem key={tier} selected={value === tier} onClick={() => onSelect(tier)}>
            <span className="min-w-0 flex-1 truncate">{effortLabel(tier)}</span>
            <span className="text-ui-caption ml-auto text-muted-foreground">{tier}</span>
          </PickerMenuItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
