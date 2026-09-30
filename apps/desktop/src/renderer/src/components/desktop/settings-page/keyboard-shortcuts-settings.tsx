import { Pencil, Search } from "lucide-react"
import { useState, useSyncExternalStore } from "react"

import {
  getShortcutRevision,
  setShortcutBinding,
  shortcutLabel,
  subscribeShortcutChanges,
  type DesktopShortcutId,
} from "../desktop-shortcuts"
import { Kbd } from "@renderer/components/ui/kbd"

const groups: Array<{
  title: string
  shortcuts: Array<{ id: DesktopShortcutId; title: string; description: string }>
}> = [
  {
    title: "聊天",
    shortcuts: [
      { id: "newConversation", title: "新对话", description: "开始新的聊天" },
      { id: "closeConversation", title: "关闭对话", description: "关闭当前聊天" },
      { id: "previousSession", title: "上一个聊天", description: "切换到上一个聊天" },
      { id: "nextSession", title: "下一个聊天", description: "切换到下一个聊天" },
    ],
  },
  {
    title: "工作区和工具",
    shortcuts: [
      { id: "chooseProject", title: "打开文件夹", description: "选择或切换工作目录" },
      { id: "toggleSidebar", title: "切换侧边栏", description: "显示或收起左侧导航" },
      { id: "togglePanel", title: "切换工具面板", description: "显示或收起右侧工具" },
      { id: "openBrowser", title: "打开浏览器", description: "在工具面板打开浏览器" },
      { id: "openFiles", title: "打开文件树", description: "在工具面板查看文件" },
      { id: "openTerminal", title: "打开终端", description: "在工具面板打开终端" },
    ],
  },
  {
    title: "导航和窗口",
    shortcuts: [
      { id: "goBack", title: "后退", description: "返回上一页" },
      { id: "goForward", title: "前进", description: "前往下一页" },
      { id: "zoomIn", title: "放大界面", description: "增大界面缩放比例" },
      { id: "zoomOut", title: "缩小界面", description: "减小界面缩放比例" },
      { id: "resetZoom", title: "实际大小", description: "恢复默认缩放比例" },
      { id: "showShortcuts", title: "查看快捷键", description: "打开快捷键速览" },
      { id: "quit", title: "退出 Vykor", description: "关闭桌面应用" },
    ],
  },
]

function capturedShortcut(event: React.KeyboardEvent<HTMLInputElement>, isMac: boolean) {
  if (event.key === "Escape") return "cancel" as const
  if (!event.code || /^(Control|Meta|Shift|Alt)/.test(event.code)) return null
  if (!(isMac ? event.metaKey : event.ctrlKey)) return null
  const key = event.code.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1")
  const modifiers = [event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean)
  return {
    binding: ["$mod", ...modifiers, event.code].join("+"),
    keys: [...modifiers, key].join("+"),
  }
}

export function KeyboardShortcutsSettings(): React.JSX.Element {
  useSyncExternalStore(subscribeShortcutChanges, getShortcutRevision)
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<DesktopShortcutId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isMac = navigator.platform.toLowerCase().includes("mac")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) =>
        [shortcut.title, shortcut.description, group.title, shortcutLabel(shortcut.id, isMac)]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ),
    }))
    .filter((group) => group.shortcuts.length > 0)

  return (
    <div className="space-y-8">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          aria-label="搜索快捷键"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索快捷键或操作"
          className="h-11 w-full rounded-xl border border-input bg-background pr-4 pl-11 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
        />
      </div>

      {visibleGroups.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">没有找到匹配的快捷键</p>
      ) : (
        visibleGroups.map((group) => (
          <section key={group.title} aria-label={group.title} className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">{group.title}</h2>
            <div className="divide-y divide-border/70 rounded-xl border border-border/70 bg-background px-5">
              {group.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="grid min-h-19 grid-cols-1 gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] sm:items-center sm:gap-6"
                >
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-foreground">{shortcut.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {shortcut.description}
                    </p>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 sm:justify-end">
                    {editing === shortcut.id ? (
                      <div className="min-w-0 flex-1">
                        <input
                          autoFocus
                          readOnly
                          aria-label={`录入${shortcut.title}快捷键`}
                          placeholder={isMac ? "按下 ⌘ + 按键" : "按下 Ctrl + 按键"}
                          className="h-9 w-full rounded-lg border border-ring bg-background px-2 text-xs ring-2 ring-ring/20 outline-none"
                          onBlur={() => {
                            setEditing(null)
                            setError(null)
                          }}
                          onKeyDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            const captured = capturedShortcut(event, isMac)
                            if (captured === "cancel") {
                              setEditing(null)
                              setError(null)
                              return
                            }
                            if (!captured) {
                              setError("请同时按下主功能键和一个普通按键")
                              return
                            }
                            const result = setShortcutBinding(
                              shortcut.id,
                              captured.binding,
                              captured.keys
                            )
                            if (result === "updated") {
                              setEditing(null)
                              setError(null)
                            } else
                              setError(
                                result === "conflict"
                                  ? "这个组合已被其他操作使用"
                                  : "无法使用这个按键组合"
                              )
                          }}
                        />
                        {error ? (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <Kbd className="h-7 max-w-full min-w-0 rounded-full px-2.5 text-xs font-normal">
                          {shortcutLabel(shortcut.id, isMac)}
                        </Kbd>
                        <button
                          type="button"
                          aria-label={`修改${shortcut.title}快捷键`}
                          title={`修改${shortcut.title}快捷键`}
                          onClick={() => {
                            setEditing(shortcut.id)
                            setError(null)
                          }}
                          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
