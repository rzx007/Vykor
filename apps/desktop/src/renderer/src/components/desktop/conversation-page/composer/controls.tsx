import { ArrowUp, Check, ChevronDown, ShieldCheck, Square } from "lucide-react"
import { forwardRef } from "react"

import { Button } from "@renderer/components/ui/button"
import { Item, ItemActions } from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionMode } from "@shared/session-types"
import type { PermissionModeOption } from "../types"

export const permissionModeOptions: PermissionModeOption[] = [
  {
    value: "default",
    label: "手动批准",
    description: "写入、命令等敏感操作会请求确认。",
  },
  {
    value: "plan",
    label: "计划模式",
    description: "保持只读分析，适合先审方案。",
  },
  {
    value: "full_auto",
    label: "自动批准",
    description: "自动批准工具操作，仍遵守禁止规则和访问边界。",
  },
]

export function PermissionModeMenu({
  selected,
  onSelect,
  className,
}: {
  selected: DesktopPermissionMode
  onSelect: (mode: DesktopPermissionMode) => void
  className?: string
}): React.JSX.Element {
  return (
    <div role="menu" className={cn("text-popover-foreground", className)}>
      {permissionModeOptions.map((mode) => (
        <Button
          key={mode.value}
          type="button"
          variant="ghost"
          role="menuitemradio"
          aria-checked={selected === mode.value}
          onClick={() => onSelect(mode.value)}
          className={cn(
            "h-auto w-full items-start justify-start gap-2 px-2 py-2 text-left font-normal whitespace-normal",
            selected === mode.value && "bg-muted"
          )}
        >
          <ShieldCheck className="mt-0.5 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">{mode.label}</span>
            <span className="text-ui-caption mt-0.5 block text-muted-foreground">
              {mode.description}
            </span>
          </span>
          {selected === mode.value ? <Check className="mt-0.5" /> : null}
        </Button>
      ))}
    </div>
  )
}

export const StartPickerButton = forwardRef<
  HTMLButtonElement,
  {
    label: string
    expanded: boolean
    children: React.ReactNode
  } & React.ComponentProps<typeof Button>
>(function StartPickerButton({ label, expanded, children, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      aria-expanded={expanded}
      aria-haspopup="menu"
      className={cn(
        "h-8 max-w-56 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground hover:bg-background/75 aria-expanded:bg-background/85",
        className
      )}
      {...props}
    >
      {children}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
    </Button>
  )
})

export function PickerMenuItem({
  selected,
  disabled,
  title,
  onClick,
  children,
}: {
  selected?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Item
      size="xs"
      render={<button type="button" disabled={disabled} onClick={onClick} />}
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      title={title}
      className={cn(
        "h-8 w-full flex-nowrap justify-start bg-transparent text-left text-xs font-normal [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        selected && "bg-muted"
      )}
    >
      {children}
      {selected ? (
        <ItemActions>
          <Check className="size-3.5 text-foreground" />
        </ItemActions>
      ) : null}
    </Item>
  )
}

export function HeaderIconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
    >
      {children}
    </Button>
  )
}

export function ComposerIconButton({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className="text-muted-foreground"
    >
      {children}
    </Button>
  )
}

export function ComposerSendButton({
  sending,
  running = false,
  disabled,
  onInterrupt,
}: {
  sending: boolean
  running?: boolean
  disabled: boolean
  onInterrupt?: () => void
}): React.JSX.Element {
  if (sending) {
    return (
      <Button
        type="button"
        size="icon"
        disabled
        aria-busy
        aria-label="正在发送"
        title="正在发送"
        className="ml-1 size-8 rounded-full disabled:opacity-100"
      >
        <Spinner />
      </Button>
    )
  }

  if (running) {
    return (
      <Button
        type="button"
        size="icon"
        aria-label="停止生成"
        title="停止生成"
        onClick={onInterrupt}
        className="ml-1 size-8 rounded-full  hover:bg-primary/90"
      >
        <Square fill="currentColor" className="size-3.5" />
      </Button>
    )
  }

  return (
    <Button
      type="submit"
      size="icon"
      aria-label="发送"
      title="发送"
      disabled={disabled}
      className="ml-1 size-8 rounded-full hover:bg-primary/90 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
    >
      <ArrowUp />
    </Button>
  )
}
