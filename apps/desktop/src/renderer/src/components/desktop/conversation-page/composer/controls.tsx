import { ArrowUp, Check, ChevronDown, Folder, Globe, Hand, ShieldAlert, ShieldCheck, Square, SquareTerminal, TriangleAlert } from "lucide-react"
import { forwardRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Item, ItemActions } from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@renderer/components/ui/alert-dialog"
import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionMode } from "@shared/session-types"
import type { PermissionModeOption } from "../shared/types"

export const permissionModeIcons: Record<DesktopPermissionMode, typeof ShieldCheck> = {
  ask: Hand,
  auto_review: ShieldCheck,
  full_access: ShieldAlert,
}

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

// Popover owns dismissal and focus restoration; only list navigation belongs here.
// eslint-disable-next-line react-refresh/only-export-components -- Shared behavior stays with the composer controls.
export function handlePickerMenuKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return
  const { currentTarget: menu, target, key } = event
  const scopeSelector = '[role="menu"], [data-slot="popover-content"], [data-slot="dialog-content"]'
  if (
    !(target instanceof HTMLElement) ||
    !menu.contains(target) ||
    target.closest(scopeSelector) !== menu
  )
    return
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return
  const editing = target.closest('input, textarea, [contenteditable="true"]')
  if (editing && (key === "Home" || key === "End")) return

  const items = [
    ...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
  ].filter((item) => {
    if (item.closest(scopeSelector) !== menu || item.matches(':disabled, [aria-disabled="true"]'))
      return false
    for (let element: HTMLElement | null = item; element; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (
        element.hidden ||
        element.hasAttribute("inert") ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return false
      if (element === menu) break
    }
    return true
  })
  if (items.length === 0) return
  const current = items.indexOf(
    target.closest<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')!
  )
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : current < 0
          ? key === "ArrowDown"
            ? 0
            : items.length - 1
          : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length
  event.preventDefault()
  items[next]?.focus()
  items[next]?.scrollIntoView?.({ block: "nearest" })
}

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
    <div role="menu" onKeyDown={handlePickerMenuKeyDown} className={cn("text-popover-foreground", className)}>
      {permissionModeOptions.map((mode) => {
        const ModeIcon = permissionModeIcons[mode.value]
        const warning = mode.value === "full_access"
        return (
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
            selected === mode.value && "bg-muted",
            warning && "text-status-warning hover:text-status-warning"
          )}
        >
          <ModeIcon className={cn("mt-0.5", warning ? "text-status-warning" : "text-muted-foreground")} strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className={cn("block text-xs font-medium", warning ? "text-status-warning" : "text-foreground")}>{mode.label}</span>
            <span className={cn("text-ui-caption mt-0.5 block", warning ? "text-status-warning" : "text-muted-foreground")}>
              {mode.description}
            </span>
          </span>
          {selected === mode.value ? <Check className="mt-0.5" /> : null}
        </Button>
        )
      })}
    </div>
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent className="w-[calc(100%-2rem)] gap-4 rounded-3xl p-6 data-[size=default]:max-w-[36rem] data-[size=default]:sm:max-w-[36rem]">
        <AlertDialogHeader className="place-items-start gap-3 text-left">
          <AlertDialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <TriangleAlert aria-hidden="true" className="size-5 shrink-0" />
            要开启完全访问权限吗？
          </AlertDialogTitle>
          <AlertDialogDescription className="text-left leading-6">
            Vykor 可以在当前执行环境允许的范围内，无需逐次批准地进行以下操作：
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y divide-border/60 rounded-2xl bg-muted/70 px-4">
          <li className="flex items-center gap-3 py-3">
            <Folder aria-hidden="true" className="size-6 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">文件和文件夹</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">读取、创建、修改、上传或删除当前环境中的文件</p>
            </div>
          </li>
          <li className="flex items-center gap-3 py-3">
            <SquareTerminal aria-hidden="true" className="size-6 shrink-0 text-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">终端命令</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">在系统权限允许的范围内运行命令、安装软件或修改设置</p>
            </div>
          </li>
          <li className="flex items-center gap-3 py-3">
            <Globe aria-hidden="true" className="size-6 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">互联网和已连接的应用</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">访问网站、发送数据，并使用已授权的应用和插件</p>
            </div>
          </li>
        </ul>
        <details className="text-sm leading-6 text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>这可能带来数据丢失、隐私泄露或误操作风险。你可以随时切换回其他授权模式。</span>
            <span className="shrink-0 text-primary">了解更多</span>
          </summary>
          <p className="mt-2 text-xs leading-5">
            此设置仅作用于当前聊天，不会提升系统权限。计划模式、明确禁止的操作和外部应用自己的登录授权仍然适用。
          </p>
        </details>
        <AlertDialogFooter className="m-0 flex-row justify-end gap-3 rounded-none border-0 bg-transparent p-0">
          <AlertDialogCancel variant="secondary" className="h-9 min-w-20 rounded-full px-5">取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" shape="pill" className="h-9 min-w-24" disabled={disabled}
            onClick={() => { setConfirm(false); onSelect("full_access") }}>
            <TriangleAlert data-icon="inline-start" />
            确认
          </AlertDialogAction>
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
      shape="pill"
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
  className,
  onClick,
  children,
}: {
  selected?: boolean
  disabled?: boolean
  title?: string
  className?: string
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
        selected && "bg-muted",
        className
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
  interrupting = false,
  disabled,
  onInterrupt,
}: {
  sending: boolean
  running?: boolean
  interrupting?: boolean
  disabled: boolean
  onInterrupt?: () => void
}): React.JSX.Element {
  if (interrupting || sending) {
    return (
      <Button
        type="button"
        size="icon"
        disabled
        aria-busy
        aria-label={interrupting ? "正在停止" : "正在发送"}
        title={interrupting ? "正在停止" : "正在发送"}
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
