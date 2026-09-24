import { useEffect, useState } from "react"
import { ArrowLeft, ArrowRight, Minus, Square, X } from "lucide-react"
import { IconLayoutSidebar } from "@tabler/icons-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { shortcutLabel } from "@renderer/components/desktop/desktop-shortcuts"
import { UpdateStatusCapsule } from "@renderer/components/desktop/update/update-status-capsule"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { cn } from "@renderer/lib/utils"
import type { DesktopAppInfo } from "@shared/ipc-channels"
import { actualSizeZoomLevel, maximumZoomLevel, minimumZoomLevel } from "@shared/zoom"
import type { UtilityToolRequest } from "./main-layout/utility-panel"

type TitleBarProps = {
  sidebarOpen: boolean
  panelOpen: boolean
  isMaximized: boolean
  hasActiveSession: boolean
  canGoBack: boolean
  canGoForward: boolean
  canOpenPreviousSession: boolean
  canOpenNextSession: boolean
  zoomLevel: number
  onGoBack: () => void
  onGoForward: () => void
  onNewConversation: () => void
  onChooseProject: () => void
  onCloseConversation: () => void
  onOpenPreviousSession: () => void
  onOpenNextSession: () => void
  onToggleSidebar: () => void
  onTogglePanel: () => void
  onOpenUtilityTool: (tool: UtilityToolRequest) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

type InfoDialog = "shortcuts" | "about" | null

const menuTriggerClass =
  "text-ui-small h-7 rounded px-2.5 text-ui-muted/80 transition-colors hover:bg-black/5 hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none data-popup-open:bg-black/5 data-popup-open:text-ui-foreground"

export function TitleBar({
  sidebarOpen,
  panelOpen,
  isMaximized,
  hasActiveSession,
  canGoBack,
  canGoForward,
  canOpenPreviousSession,
  canOpenNextSession,
  zoomLevel,
  onGoBack,
  onGoForward,
  onNewConversation,
  onChooseProject,
  onCloseConversation,
  onOpenPreviousSession,
  onOpenNextSession,
  onToggleSidebar,
  onTogglePanel,
  onOpenUtilityTool,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps): React.JSX.Element {
  const [lastEditingTarget, setLastEditingTarget] = useState<HTMLElement | null>(null)
  const [infoDialog, setInfoDialog] = useState<InfoDialog>(null)
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    const rememberEditingTarget = (event: FocusEvent): void => {
      if (isEditableElement(event.target)) setLastEditingTarget(event.target)
    }
    document.addEventListener("focusin", rememberEditingTarget)
    return () => document.removeEventListener("focusin", rememberEditingTarget)
  }, [])

  useEffect(() => {
    void window.desktop.app.getPlatform().then((platform) => setIsMac(platform.isMac))
  }, [])

  useEffect(() => {
    if (infoDialog !== "about" || appInfo) return
    void window.desktop.app.getInfo().then(setAppInfo)
  }, [appInfo, infoDialog])

  useDesktopShortcuts({ showShortcuts: () => setInfoDialog("shortcuts") })

  const runEditCommand = (command: string): void => {
    const target = lastEditingTarget?.isConnected ? lastEditingTarget : null
    target?.focus()
    document.execCommand(command)
  }

  const paste = (): void => {
    const target = lastEditingTarget?.isConnected ? lastEditingTarget : null
    if (!target) return
    void window.desktop.clipboard.readText().then((text) => {
      target.focus()
      document.execCommand("insertText", false, text)
    })
  }

  const openDocumentation = (): void => {
    window.open("https://github.com/rzx007/Vykor#readme", "_blank", "noopener")
  }

  return (
    <>
      <header className="titlebar-drag flex h-9 shrink-0 items-center bg-transparent text-ui-foreground select-none">
        {isMac ? (
          <div className="h-full w-19 shrink-0" data-titlebar-traffic-light-space aria-hidden />
        ) : null}
        <div className="titlebar-no-drag flex h-full items-center gap-0.5 px-2">
          <ToolbarButton
            label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
            pressed={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <IconLayoutSidebar className="size-3.6!" />
          </ToolbarButton>
          <ToolbarButton label="后退" disabled={!canGoBack} onClick={onGoBack}>
            <ArrowLeft />
          </ToolbarButton>
          <ToolbarButton label="前进" disabled={!canGoForward} onClick={onGoForward}>
            <ArrowRight />
          </ToolbarButton>
        </div>

        <nav className="titlebar-no-drag ml-1 flex h-full items-center" aria-label="应用菜单">
          <DropdownMenu>
            <DropdownMenuTrigger className={menuTriggerClass}>文件</DropdownMenuTrigger>
            <DropdownMenuContent sideOffset={0} className="min-w-64">
              <DropdownMenuItem onClick={onNewConversation}>
                新对话
                <DropdownMenuShortcut>
                  {shortcutLabel("newConversation", isMac)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onChooseProject}>
                打开文件夹…
                <DropdownMenuShortcut>{shortcutLabel("chooseProject", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!hasActiveSession} onClick={onCloseConversation}>
                关闭当前对话
                <DropdownMenuShortcut>
                  {shortcutLabel("closeConversation", isMac)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void window.desktop.app.quit()}>
                退出 Vykor
                <DropdownMenuShortcut>{shortcutLabel("quit", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={menuTriggerClass}>编辑</DropdownMenuTrigger>
            <DropdownMenuContent sideOffset={0} className="min-w-64">
              <DropdownMenuItem
                disabled={!lastEditingTarget}
                onClick={() => runEditCommand("undo")}
              >
                撤销
                <DropdownMenuShortcut>Ctrl+Z</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!lastEditingTarget}
                onClick={() => runEditCommand("redo")}
              >
                重做
                <DropdownMenuShortcut>Ctrl+Y</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!lastEditingTarget} onClick={() => runEditCommand("cut")}>
                剪切
                <DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runEditCommand("copy")}>
                复制
                <DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!lastEditingTarget} onClick={paste}>
                粘贴
                <DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!lastEditingTarget}
                onClick={() => runEditCommand("delete")}
              >
                删除
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!lastEditingTarget}
                onClick={() => runEditCommand("selectAll")}
              >
                全选
                <DropdownMenuShortcut>Ctrl+A</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={menuTriggerClass}>视图</DropdownMenuTrigger>
            <DropdownMenuContent sideOffset={0} className="min-w-72">
              <DropdownMenuCheckboxItem checked={sidebarOpen} onClick={onToggleSidebar}>
                显示侧边栏
                <DropdownMenuShortcut>{shortcutLabel("toggleSidebar", isMac)}</DropdownMenuShortcut>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={panelOpen} onClick={onTogglePanel}>
                显示工具面板
                <DropdownMenuShortcut>{shortcutLabel("togglePanel", isMac)}</DropdownMenuShortcut>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onOpenUtilityTool("terminal")}>
                打开终端
                <DropdownMenuShortcut>{shortcutLabel("openTerminal", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onOpenUtilityTool("files")}>
                打开文件树
                <DropdownMenuShortcut>{shortcutLabel("openFiles", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onOpenUtilityTool("browser")}>
                打开浏览器
                <DropdownMenuShortcut>{shortcutLabel("openBrowser", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasActiveSession}
                onClick={() => onOpenUtilityTool("agents")}
              >
                打开子智能体
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!canOpenPreviousSession} onClick={onOpenPreviousSession}>
                上一个聊天
                <DropdownMenuShortcut>
                  {shortcutLabel("previousSession", isMac)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canOpenNextSession} onClick={onOpenNextSession}>
                下一个聊天
                <DropdownMenuShortcut>{shortcutLabel("nextSession", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canGoBack} onClick={onGoBack}>
                后退
                <DropdownMenuShortcut>{shortcutLabel("goBack", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canGoForward} onClick={onGoForward}>
                前进
                <DropdownMenuShortcut>{shortcutLabel("goForward", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={zoomLevel >= maximumZoomLevel} onClick={onZoomIn}>
                放大
                <DropdownMenuShortcut>{shortcutLabel("zoomIn", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={zoomLevel <= minimumZoomLevel} onClick={onZoomOut}>
                缩小
                <DropdownMenuShortcut>{shortcutLabel("zoomOut", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={zoomLevel === actualSizeZoomLevel} onClick={onResetZoom}>
                实际大小
                <DropdownMenuShortcut>{shortcutLabel("resetZoom", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={menuTriggerClass}>帮助</DropdownMenuTrigger>
            <DropdownMenuContent sideOffset={0} className="min-w-64">
              <DropdownMenuItem onClick={openDocumentation}>文档</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInfoDialog("shortcuts")}>
                键盘快捷键
                <DropdownMenuShortcut>{shortcutLabel("showShortcuts", isMac)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setInfoDialog("about")}>
                关于 Vykor
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        <div className="titlebar-no-drag ml-auto flex h-full items-stretch">
          <UpdateStatusCapsule />
          {isMac ? null : (
            <>
              <WindowButton label="最小化" onClick={onMinimize}>
                <Minus />
              </WindowButton>
              <WindowButton label={isMaximized ? "还原" : "最大化"} onClick={onToggleMaximize}>
                {isMaximized ? <CopySquareIcon /> : <Square />}
              </WindowButton>
              <WindowButton label="关闭" danger onClick={onClose}>
                <X />
              </WindowButton>
            </>
          )}
        </div>
      </header>

      <Dialog
        open={infoDialog === "shortcuts"}
        onOpenChange={(open) => !open && setInfoDialog(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>键盘快捷键</DialogTitle>
            <DialogDescription>常用的窗口导航和工具入口。</DialogDescription>
          </DialogHeader>
          <ShortcutList isMac={isMac} />
        </DialogContent>
      </Dialog>

      <Dialog open={infoDialog === "about"} onOpenChange={(open) => !open && setInfoDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vykor</DialogTitle>
            <DialogDescription>面向本地项目和智能代理协作的桌面工作区。</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-muted/55 p-3 text-xs">
            <dt className="text-muted-foreground">版本</dt>
            <dd>{appInfo?.version ?? "正在读取…"}</dd>
            <dt className="text-muted-foreground">运行方式</dt>
            <dd>{appInfo ? (appInfo.isPackaged ? "桌面安装包" : "开发模式") : "正在读取…"}</dd>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ShortcutList({ isMac }: { isMac: boolean }): React.JSX.Element {
  const shortcuts = [
    ["新对话", shortcutLabel("newConversation", isMac)],
    ["打开文件夹", shortcutLabel("chooseProject", isMac)],
    ["后退 / 前进", `${shortcutLabel("goBack", isMac)} / ${shortcutLabel("goForward", isMac)}`],
    [
      "上 / 下一个聊天",
      `${shortcutLabel("previousSession", isMac)} / ${shortcutLabel("nextSession", isMac)}`,
    ],
    ["切换侧边栏", shortcutLabel("toggleSidebar", isMac)],
    ["切换工具面板", shortcutLabel("togglePanel", isMac)],
    ["打开终端", shortcutLabel("openTerminal", isMac)],
    ["打开文件树", shortcutLabel("openFiles", isMac)],
    ["放大 / 缩小", `${shortcutLabel("zoomIn", isMac)} / ${shortcutLabel("zoomOut", isMac)}`],
    ["实际大小", shortcutLabel("resetZoom", isMac)],
  ]
  return (
    <dl className="divide-y divide-border rounded-lg border border-border px-3">
      {shortcuts.map(([label, shortcut]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-2.5 text-xs">
          <dt>{label}</dt>
          <dd className="text-ui-caption font-mono text-muted-foreground">{shortcut}</dd>
        </div>
      ))}
    </dl>
  )
}

function isEditableElement(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.matches("input, textarea, select, [contenteditable='true']") ||
      target.closest("[contenteditable='true']")
    )
  )
}

function ToolbarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded text-ui-muted transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-4",
        "hover:bg-black/5 hover:text-ui-foreground active:bg-black/8",
        "disabled:pointer-events-none disabled:opacity-35",
        pressed && "bg-black/5 text-ui-foreground"
      )}
    >
      {children}
    </button>
  )
}

function WindowButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-full w-12 place-items-center text-ui-foreground transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset [&_svg]:size-3.5",
        danger
          ? "hover:bg-red-600 hover:text-white active:bg-red-700"
          : "hover:bg-black/7 active:bg-black/10"
      )}
    >
      {children}
    </button>
  )
}

function CopySquareIcon(): React.JSX.Element {
  return (
    <span className="relative block size-3.5" aria-hidden="true">
      <span className="absolute top-0 right-0 size-2.5 rounded-xs border border-current" />
      <span className="absolute bottom-0 left-0 size-2.5 rounded-xs border border-current bg-shell" />
    </span>
  )
}
