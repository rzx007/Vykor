import { CircleHelp } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"

interface FieldHelpProps {
  /** 提示气泡里的说明正文。 */
  children: React.ReactNode
  /** 问号按钮的可读名称，读屏和键盘用户靠它知道这里有说明。 */
  label: string
}

/**
 * 表单标签旁的小问号：把较长的说明收进 tooltip，减少界面上的文字噪点。
 */
export function FieldHelp({ children, label }: FieldHelpProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={label}
          />
        }
      >
        <CircleHelp className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}
