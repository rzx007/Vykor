import { RotateCcw } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"

export function SettingsResetButton({
  label,
  onReset,
  disabled,
}: {
  label: string
  onReset?: () => void
  disabled?: boolean
}) {
  if (!onReset) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            shape="circle"
            className="text-muted-foreground"
            aria-label={label}
            disabled={disabled}
            onClick={onReset}
          />
        }
      >
        <RotateCcw aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent role="tooltip">{label}</TooltipContent>
    </Tooltip>
  )
}
