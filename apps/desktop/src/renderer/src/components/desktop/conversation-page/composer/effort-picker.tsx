import { ChevronDown, Gauge } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import type { DesktopModel } from "@shared/session-types"
import { handlePickerMenuKeyDown, PickerMenuItem } from "./controls"

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

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  default: "由模型提供商决定分析程度。",
  none: "不启用额外推理。",
  minimal: "尽量减少额外分析，通常更快。",
  low: "较少分析，适合简单任务。",
  medium: "平衡分析程度与响应时间。",
  high: "更充分地分析，可能等待更久。",
  xhigh: "深入分析复杂问题，可能等待更久。",
  max: "尽可能深入分析，可能等待更久。",
  ultra: "尽可能深入分析，可能等待更久。",
}

export function effortLabel(value: string): string {
  return Object.hasOwn(EFFORT_LABELS, value) ? EFFORT_LABELS[value] : value
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
  triggerClassName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tiers: string[]
  value: string | null
  onSelect: (effort: string) => void
  triggerClassName?: string
}): React.JSX.Element | null {
  if (tiers.length === 0) return null
  const label = value && tiers.includes(value) ? effortLabel(value) : "默认"
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-haspopup="menu"
        render={
          <Button
            type="button"
            variant="ghost"
            shape="pill"
            aria-label="推理强度"
            title={`推理强度：${label}`}
            className={cn(
              "h-8 max-w-32 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground",
              triggerClassName
            )}
          />
        }
      >
        <Gauge data-icon="inline-start" />
        <span data-slot="effort-label" className="min-w-0 truncate">
          {label}
        </span>
        <ChevronDown data-slot="effort-chevron" data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        onKeyDown={handlePickerMenuKeyDown}
        side="top"
        align="end"
        sideOffset={8}
        className="w-64 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
      >
        <PickerMenuItem
          selected={!value || !tiers.includes(value)}
          onClick={() => onSelect("")}
          className="h-auto min-h-8 items-start"
        >
          <span className="min-w-0 flex-1">
            <span className="block">默认</span>
            <span className="text-ui-caption mt-0.5 block text-muted-foreground">
              {EFFORT_DESCRIPTIONS.default}
            </span>
          </span>
        </PickerMenuItem>
        {tiers.map((tier) => (
          <PickerMenuItem
            key={tier}
            selected={value === tier}
            onClick={() => onSelect(tier)}
            className="h-auto min-h-8 items-start"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span>{effortLabel(tier)}</span>
                <span className="text-ui-caption text-muted-foreground">{tier}</span>
              </span>
              <span className="text-ui-caption mt-0.5 block text-muted-foreground">
                {Object.hasOwn(EFFORT_DESCRIPTIONS, tier)
                  ? EFFORT_DESCRIPTIONS[tier]
                  : "使用此模型提供的分析档位。"}
              </span>
            </span>
          </PickerMenuItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
