import { ArrowUp, Check, ChevronDown, ShieldCheck, Square } from "lucide-react"
import { forwardRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Item, ItemActions } from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@renderer/components/ui/alert-dialog"
import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionMode } from "@shared/session-types"
import type { PermissionModeOption } from "../shared/types"

export const permissionModeOptions: PermissionModeOption[] = [
  {
    value: "ask",
    label: "请我批准",
    description: "写入、命令等敏感操作会请求确认。",
  },
  {
    value: "auto_review",
    label: "帮我批准",
    description: "由独立审查判断操作，必要时再请你确认。",
  },
  {
    value: "full_access",
    label: "完全访问权限",
    description: "扩大当前环境的访问权限，仍遵守计划限制和强制禁止规则。",
  },
]

export function PermissionModeMenu({
  selected,
  onSelect,
  className,
  disabled = false,
}: {
  selected: DesktopPermissionMode
  onSelect: (mode: DesktopPermissionMode) => void
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
    <div role="menu" className={cn("text-popover-foreground", className)}>
      {permissionModeOptions.map((mode) => (
        <Button
          key={mode.value}
          type="button"
          variant="ghost"
          role="menuitemradio"
          aria-checked={selected === mode.value}
          disabled={disabled}
          onClick={() => {
            if (mode.value === "full_access" && selected !== "full_access") setConfirm(true)
            else onSelect(mode.value)
          }}
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
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>启用完全访问权限？</AlertDialogTitle>
          <AlertDialogDescription>
            当前聊天可在执行环境允许的范围内访问文件、命令和网络，普通操作通常不再请求批准。计划模式和强制禁止规则仍然生效。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={() => onSelect("full_access")}>启用完全访问权限</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
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
