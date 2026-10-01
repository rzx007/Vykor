import { ClipboardCopy, ClipboardPaste, Eraser, RotateCcw, X } from "lucide-react"
import type * as React from "react"
import { cn } from "@renderer/lib/utils"

export type TerminalContextMenuState = {
  x: number
  y: number
  selectedText: string
}

export function TerminalContextMenu({
  menuRef,
  state,
  canPaste,
  canManage,
  onCopy,
  onPaste,
  onClear,
  onRestart,
  onClose,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>
  state: TerminalContextMenuState
  canPaste: boolean
  canManage: boolean
  onCopy: () => void
  onPaste: () => void
  onClear: () => void
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left: state.x, top: state.y }}
      className="text-ui-small fixed z-[100] w-44 rounded-md border border-border/80 bg-popover p-1 text-popover-foreground shadow-xl outline-none"
    >
      <TerminalContextMenuItem disabled={!state.selectedText} onClick={onCopy}>
        <ClipboardCopy />
        复制选区
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canPaste} onClick={onPaste}>
        <ClipboardPaste />
        粘贴
      </TerminalContextMenuItem>
      <div role="separator" className="-mx-1 my-1 h-px bg-border/75" />
      <TerminalContextMenuItem disabled={!canManage} onClick={onClear}>
        <Eraser />
        清空
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canManage} onClick={onRestart}>
        <RotateCcw />
        重启
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canManage} onClick={onClose} destructive>
        <X />
        关闭
      </TerminalContextMenuItem>
    </div>
  )
}

function TerminalContextMenuItem({
  disabled,
  destructive,
  onClick,
  children,
}: {
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded px-2 text-left transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
      )}
    >
      {children}
    </button>
  )
}
