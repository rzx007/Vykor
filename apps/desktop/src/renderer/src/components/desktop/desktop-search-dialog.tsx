import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { FolderOpen, Search, SquarePen } from "lucide-react"
import { CommandPalette, type CommandItem } from "@renderer/components/motion/command-palette"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { isChannelSession, isTopLevelSession } from "@renderer/stores/desktop-session/helpers"
import {
  selectArchivedSessions,
  selectProjects,
  selectSessions,
} from "@renderer/stores/desktop-session/selectors"
import { channelConnectorLabel } from "@shared/channel-types"
import type { DesktopSessionSearchResult } from "@shared/session-types"
import { useOnOpen } from "@renderer/lib/hooks/use-on-open"
import { settingsNavigation } from "./settings-page/settings-navigation"
import { getShortcutRevision, shortcutLabel, subscribeShortcutChanges } from "./desktop-shortcuts"

const GROUP_ORDER = ["聊天", "已归档聊天", "聊天内容", "快捷操作", "设置"]
const INITIAL_LIMITS = { 聊天: 9, 已归档聊天: 0 }

export function DesktopSearchDialog({
  open,
  onOpenChange,
  onOpenConversation,
  onNewConversation,
  onChooseProject,
  onSearchFiles,
  onOpenSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenConversation: (sessionId: string) => void
  onNewConversation: () => void
  onChooseProject: () => void
  onSearchFiles: () => void
  onOpenSettings: (section: string) => void
}): React.JSX.Element {
  const sessions = useDesktopSessionStore(selectSessions)
  const archivedSessions = useDesktopSessionStore(selectArchivedSessions)
  const projects = useDesktopSessionStore(selectProjects)
  const [query, setQuery] = useState("")
  const [contentSearch, setContentSearch] = useState<{
    query: string
    results: DesktopSessionSearchResult[]
    error?: string
  }>({ query: "", results: [] })
  useOnOpen(open, () => {
    setQuery("")
    setContentSearch({ query: "", results: [] })
  })
  useEffect(() => {
    if (!open || !query.trim() || query.length > 256) return
    let cancelled = false
    const timer = setTimeout(() => {
      window.desktop.sessions.search({ query, limit: 30 }).then(
        (results) => {
          if (!cancelled) setContentSearch({ query, results })
        },
        () => {
          if (!cancelled)
            setContentSearch({ query, results: [], error: "聊天内容搜索失败，请修改关键词重试。" })
        }
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])
  const searchResults = useMemo(
    () => ({
      query: contentSearch.query,
      items: contentSearch.results.map((result) => ({
        id: "session:content:" + result.session.id,
        label: result.session.title || "未命名对话",
        description: result.snippet,
        group: "聊天内容",
        badge: result.session.status === "archived" ? "已归档" : undefined,
        onSelect: () => onOpenConversation(result.session.id),
      })),
    }),
    [contentSearch, onOpenConversation]
  )
  const searchStatus = !query.trim()
    ? undefined
    : query.length > 256
      ? "搜索关键词不能超过 256 个字符。"
      : contentSearch.query !== query
        ? "正在搜索聊天内容…"
        : contentSearch.error
  useSyncExternalStore(subscribeShortcutChanges, getShortcutRevision)
  const isMac = navigator.platform.toLowerCase().includes("mac")
  const newConversationHint = shortcutLabel("newConversation", isMac)
  const chooseProjectHint = shortcutLabel("chooseProject", isMac)
  const openFilesHint = shortcutLabel("openFiles", isMac)
  const items = useMemo<CommandItem[]>(() => {
    const records = [
      ...new Map(
        [...archivedSessions, ...sessions].filter(isTopLevelSession).map((item) => [item.id, item])
      ).values(),
    ].sort((a, b) => b.updatedAt - a.updatedAt)
    const chats: CommandItem[] = records.map((session) => {
      let projectName =
        projects.find(
          (project) =>
            project.id === session.projectId ||
            project.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() ===
              session.cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
        )?.name ?? "项目外"
      if (isChannelSession(session)) {
        const binding = session.metadata.externalConversation as Record<string, unknown> | undefined
        projectName = channelConnectorLabel(
          typeof binding?.connector === "string" ? binding.connector : undefined
        )
      }
      return {
        id: "session:" + session.id,
        label: session.title || "未命名对话",
        group: session.status === "archived" ? "已归档聊天" : "聊天",
        badge: projectName,
        keywords: [
          projectName,
          projectName.toLowerCase(),
          session.title.toLowerCase(),
          session.cwd,
        ],
        onSelect: () => onOpenConversation(session.id),
      }
    })
    const actions: CommandItem[] = [
      {
        id: "new",
        label: "新对话",
        group: "快捷操作",
        icon: SquarePen,
        hint: newConversationHint,
        keywords: ["新聊天", "new chat"],
        onSelect: onNewConversation,
      },
      {
        id: "folder",
        label: "打开文件夹",
        group: "快捷操作",
        icon: FolderOpen,
        hint: chooseProjectHint,
        keywords: ["打开项目", "open folder"],
        onSelect: onChooseProject,
      },
      {
        id: "files",
        label: "搜索文件",
        group: "快捷操作",
        icon: Search,
        hint: openFilesHint,
        keywords: ["文件树", "file search"],
        onSelect: onSearchFiles,
      },
    ]
    const settings: CommandItem[] = settingsNavigation
      .map((item) => ({
        id: "setting:" + item.slug,
        label: item.label,
        group: "设置",
        icon: item.icon,
        keywords: [item.slug],
        onSelect: () => onOpenSettings(item.slug),
      }))
    return [...chats, ...actions, ...settings]
  }, [
    sessions,
    archivedSessions,
    projects,
    onOpenConversation,
    onNewConversation,
    onChooseProject,
    onSearchFiles,
    onOpenSettings,
    newConversationHint,
    chooseProjectHint,
    openFilesHint,
  ])
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      onQueryChange={setQuery}
      searchResults={searchResults}
      searchStatus={searchStatus}
      shortcut={null}
      label="搜索聊天"
      placeholder="搜索聊天"
      emptyMessage="没有找到匹配的聊天或操作。试试聊天标题、正文关键词或项目名称。"
      groupOrder={GROUP_ORDER}
      initialGroupLimits={INITIAL_LIMITS}
      renderHint={(item, index) =>
        item.id.startsWith("session:")
          ? index < 9
            ? (isMac ? "⌥" : "Alt+") + (index + 1)
            : undefined
          : item.hint
      }
      onKeyDown={(event, rows) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const digit = event.code.startsWith("Digit") ? event.code.slice(5) : event.key
        if (!/^[1-9]$/.test(digit)) return
        const item = rows[Number(digit) - 1]
        if (!item?.id.startsWith("session:")) return
        event.preventDefault()
        event.stopPropagation()
        onOpenChange(false)
        item.onSelect()
      }}
    />
  )
}
