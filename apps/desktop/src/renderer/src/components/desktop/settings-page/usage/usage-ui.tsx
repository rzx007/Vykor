import type { ReactNode } from "react"
import { CircleHelp } from "lucide-react"
import { DigitSwap } from "@renderer/components/motion/digit-swap"
import { TabsContent, TabsList, TabsTrigger } from "@renderer/components/motion/tabs"
import { Button } from "@renderer/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { cn } from "@renderer/lib/utils"
import { formatTokens } from "./usage-analytics"

export function UsageHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            shape="circle"
            size="icon-xs"
            aria-label={label}
            className="size-6 shrink-0 text-muted-foreground"
          />
        }
      >
        <CircleHelp aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent className="max-w-80 text-left text-xs leading-relaxed">
        <div className="space-y-1.5">{children}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export function UsageAnimatedValue({ value }: { value: number | null }) {
  return value === null ? (
    <span>—</span>
  ) : (
    <DigitSwap value={formatTokens(value)} duration={0.18} stagger={0} />
  )
}

export type UsageTabOption = { id: string; label: string }

export function UsageTabsList({
  label,
  options,
  underline = false,
}: {
  label: string
  options: readonly UsageTabOption[]
  underline?: boolean
}) {
  return (
    <TabsList
      aria-label={label}
      wrapperClassName="min-w-0"
      className={cn(underline ? "w-full border-border/60" : "rounded-full bg-muted/70")}
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.id}
          value={option.id}
          className={cn(
            "text-xs",
            underline
              ? "min-h-9 px-3 py-2"
              : "rounded-full px-2.5 py-1.5 [&_[data-tabs-label]]:text-foreground"
          )}
          indicatorClassName={underline ? "bg-foreground" : "bg-background ring-1 ring-border/60"}
        >
          {option.label}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

export function UsageTabPanels({
  value,
  options,
  children,
  className,
}: {
  value: string
  options: readonly UsageTabOption[]
  children: ReactNode
  className?: string
}) {
  return options.map((option) => (
    <TabsContent key={option.id} value={option.id} className={cn("mt-0 min-w-0", className)}>
      {value === option.id ? children : null}
    </TabsContent>
  ))
}
