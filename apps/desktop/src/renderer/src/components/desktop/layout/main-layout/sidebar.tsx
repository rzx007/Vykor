import {
  Archive,
  Bell,
  Clock3,
  Moon,
  PlugZap,
  Search,
  Settings,
  Smartphone,
  SquarePen,
  StickyNote,
  Sun,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useMemo, useState, useSyncExternalStore } from "react"
import { useMatchRoute } from "@tanstack/react-router"

import { nextExplicitTheme } from "@renderer/components/appearance/appearance-actions"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { SharedLayoutBg } from "@renderer/components/motion/shared-layout-bg"
import { Button } from "@renderer/components/ui/button"
import {
  getShortcutRevision,
  shortcutLabel,
  subscribeShortcutChanges,
} from "@renderer/components/desktop/desktop-shortcuts"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldGroup } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Label } from "@renderer/components/ui/label"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"
import { isChannelSession, useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  groupImSessions,
  selectActiveSessionId,
  selectArchivedSessions,
  selectLoadStatus,
  selectProjects,
  selectSessions,
} from "@renderer/stores/desktop-session/selectors"
import type { DesktopProject } from "@shared/session-types"
import { useSessionActionDialogs } from "../../conversation-page/session/session-action-dialogs"
import { DaemonAutoStartCard } from "./daemon-autostart-card"
import { SidebarNavigationButton, SidebarSectionHeader } from "./sidebar-controls"
import {
  ArchivedSessionList,
  ImSessionGroup,
  ProjectGroup,
  SessionList,
  SessionRow,
  type ProjectActions,
  type SessionActions,
} from "./sidebar-session-groups"
import {
  loadSidebarSectionExpansion,
  saveSidebarSectionExpansion,
  type SidebarSectionExpansion,
} from "./sidebar-section-expansion"

type SidebarProps = {
  open: boolean
  onOpenSearch?: () => void
  onOpenSettings: () => void
  onOpenNotes?: () => void
  onOpenScheduled: () => void
  onOpenPlugins: () => void
  onOpenConversation: (sessionId?: string | null) => void
}

const secondaryNavigation = [
  { id: "notes", icon: StickyNote, label: "便签" },
  { id: "scheduled", icon: Clock3, label: "定时任务" },
  { id: "plugins", icon: PlugZap, label: "插件" },
] as const

export function Sidebar({
  open,
  onOpenSearch,
  onOpenSettings,
  onOpenNotes,
  onOpenScheduled,
  onOpenPlugins,
  onOpenConversation,
}: SidebarProps): React.JSX.Element {
  useSyncExternalStore(subscribeShortcutChanges, getShortcutRevision)
  const matchRoute = useMatchRoute()
  const { resolvedTheme, setPreference } = useAppearance()
  const scheduledSelected = Boolean(matchRoute({ to: "/scheduled" }))
  const pluginsSelected = Boolean(matchRoute({ to: "/plugins" }))
  const notesSelected = Boolean(matchRoute({ to: "/notes" }))
  const darkTheme = resolvedTheme === "dark"
  const projects = useDesktopSessionStore(selectProjects)
  const sessions = useDesktopSessionStore(selectSessions)
  const activity = useDesktopSessionStore((state) => state.activity)
  const scheduledUnread = Object.values(activity.scheduledRuns).filter(
    (item) => item.attentionState === "unread"
  ).length
  const scheduledRunning = Object.values(activity.scheduledRuns).some(
    (item) => item.executionState === "running"
  )
  const archivedSessions = useDesktopSessionStore(selectArchivedSessions)
  const imGroups = useMemo(() => groupImSessions(sessions), [sessions])
  const activeSessionId = useDesktopSessionStore(selectActiveSessionId)
  const loadStatus = useDesktopSessionStore(selectLoadStatus)
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const selectOutsideProject = useDesktopSessionStore((state) => state.selectOutsideProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const renameProject = useDesktopSessionStore((state) => state.renameProject)
  const togglePinProject = useDesktopSessionStore((state) => state.togglePinProject)
  const removeProject = useDesktopSessionStore((state) => state.removeProject)
  const rebindProject = useDesktopSessionStore((state) => state.rebindProject)
  const sessionActionsDialogs = useSessionActionDialogs()
  const [archiveMode, setArchiveMode] = useState(false)
  const [renameProjectTarget, setRenameProjectTarget] = useState<DesktopProject | null>(null)
  const [removeProjectTarget, setRemoveProjectTarget] = useState<DesktopProject | null>(null)
  const [projectName, setProjectName] = useState("")
  const [busy, setBusy] = useState(false)
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>({})
  const [sectionExpansion, setSectionExpansion] = useState<SidebarSectionExpansion>(() =>
    loadSidebarSectionExpansion()
  )

  const toggleSection = (section: keyof SidebarSectionExpansion): void => {
    setSectionExpansion((current) => {
      const next = { ...current, [section]: !current[section] }
      saveSidebarSectionExpansion(next)
      return next
    })
  }
  const recentSessions = useMemo(
    () =>
      sessions.filter(
        (session) => session.workspaceMode === "outside_project" && !isChannelSession(session)
      ),
    [sessions]
  )
  const activeProjectPath = useMemo(() => {
    const session = sessions.find((item) => item.id === activeSessionId)
    return session ? normalizePath(session.cwd) : null
  }, [activeSessionId, sessions])
  const runningSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter(
            (session) =>
              activity.sessions[session.id]?.executionState === "running" ||
              (!activity.sessions[session.id] && session.status === "running")
          )
          .map((session) => session.id)
      ),
    [activity.sessions, sessions]
  )
  const runningProject = projects.some((project) =>
    sessions.some(
      (session) =>
        session.projectId === project.id &&
        !isChannelSession(session) &&
        runningSessionIds.has(session.id)
    )
  )
  const runningIm = imGroups.some((group) =>
    group.sessions.some((session) => runningSessionIds.has(session.id))
  )
  const runningRecent = recentSessions.some((session) => runningSessionIds.has(session.id))

  const notify = (): void => {
    void window.desktop.tray.notify({
      title: "Vykor",
      body: "通知中心已连接。",
      showWhenFocused: true,
    })
  }

  const beginNewConversation = (project?: DesktopProject): void => {
    setArchiveMode(false)
    void (async () => {
      await startNewConversation()
      if (project) await selectProject(project)
      onOpenConversation(null)
    })()
  }

  const beginRecentNewConversation = (): void => {
    selectOutsideProject()
    beginNewConversation()
  }

  const beginProjectRename = (project: DesktopProject): void => {
    setProjectName(project.name)
    setRenameProjectTarget(project)
  }

  const submitProjectRename = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!renameProjectTarget || !projectName.trim() || busy) return
    setBusy(true)
    void renameProject(renameProjectTarget.path, projectName)
      .then(() => setRenameProjectTarget(null))
      .finally(() => setBusy(false))
  }

  const confirmProjectRemove = (): void => {
    if (!removeProjectTarget || busy) return
    setBusy(true)
    void removeProject(removeProjectTarget.path)
      .then(() => setRemoveProjectTarget(null))
      .finally(() => setBusy(false))
  }

  const sessionActions: SessionActions = {
    onOpen: (session) => {
      onOpenConversation(session.id)
    },
    onRename: sessionActionsDialogs.beginRename,
    onArchive: sessionActionsDialogs.beginArchive,
    onDelete: sessionActionsDialogs.beginDelete,
  }
  const projectActions: ProjectActions = {
    onNewConversation: (project) => beginNewConversation(project),
    onRename: beginProjectRename,
    onTogglePin: (project) => void togglePinProject(project.path),
    onRemove: setRemoveProjectTarget,
    onRebind: (project) => void rebindProject(project.id),
  }

  return (
    <>
      <aside
        aria-hidden={!open}
        className={cn(
          "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-transparent",
          !open && "pointer-events-none"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 px-4 pt-2 pb-2">
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-md px-1.5 text-base font-semibold hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Vykor
          </button>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={
                "搜索聊天（" +
                shortcutLabel("searchChats", navigator.platform.toLowerCase().includes("mac")) +
                "）"
              }
              aria-label="搜索"
              disabled={!onOpenSearch}
              onClick={onOpenSearch}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Search />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="通知"
              aria-label="通知"
              onClick={notify}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Bell />
            </Button>
          </div>
        </div>

        <nav className="min-w-0 px-2" aria-label="主要导航">
          <SharedLayoutBg inset={0} pillClassName="rounded-md bg-sidebar-accent">
            <div>
              <SidebarNavigationButton
                icon={SquarePen}
                label="新对话"
                onClick={() => beginNewConversation()}
              />
            </div>
            {secondaryNavigation.map(({ id, icon, label }) => {
              const isNotes = id === "notes"
              const isScheduled = id === "scheduled"
              const isPlugins = id === "plugins"
              return (
                <div key={label}>
                  <SidebarNavigationButton
                    icon={icon}
                    label={label}
                    selected={
                      (isNotes && notesSelected) ||
                      (isScheduled && scheduledSelected) ||
                      (isPlugins && pluginsSelected)
                    }
                    badge={isScheduled ? scheduledUnread : 0}
                    running={isScheduled && scheduledRunning}
                    onClick={
                      isNotes
                        ? () => {
                            setArchiveMode(false)
                            onOpenNotes?.()
                          }
                        : isScheduled
                          ? () => {
                              setArchiveMode(false)
                              onOpenScheduled()
                            }
                          : isPlugins
                            ? () => {
                                setArchiveMode(false)
                                onOpenPlugins()
                              }
                            : undefined
                    }
                  />
                </div>
              )
            })}
            <div>
              <SidebarNavigationButton
                icon={Archive}
                label="已归档"
                selected={archiveMode && !scheduledSelected}
                onClick={() => {
                  onOpenConversation()
                  setArchiveMode((current) => !current)
                }}
              />
            </div>
          </SharedLayoutBg>
        </nav>

        <ScrollArea
          horizontal={false}
          className="min-h-0 min-w-0 flex-1"
          viewportClassName="px-2 pt-4"
          contentClassName="pb-4"
        >
          {archiveMode ? (
            <ArchivedSessionList
              sessions={archivedSessions}
              activeSessionId={activeSessionId}
              actions={sessionActions}
            />
          ) : (
            <>
              <SidebarSectionHeader
                title="项目"
                expanded={sectionExpansion.projects}
                summary={projects.length}
                running={runningProject}
                onToggle={() => toggleSection("projects")}
              />
              <AnimatePresence initial={false}>
                {sectionExpansion.projects ? (
                  <motion.div
                    key="projects-section"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                      opacity: { duration: 0.14, ease: "easeOut" },
                    }}
                    className="overflow-hidden"
                  >
                    {loadStatus === "loading" && projects.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-sidebar-muted">正在加载项目...</p>
                    ) : projects.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-sidebar-muted">暂无项目</p>
                    ) : (
                      <div className="space-y-0.5">
                        {projects.map((project, index) => {
                          const path = normalizePath(project.path)
                          const defaultExpanded = activeProjectPath
                            ? activeProjectPath === path
                            : index === 0
                          const expanded = projectExpansion[path] ?? defaultExpanded
                          const projectSessions = sessions.filter(
                            (session) =>
                              samePath(session.cwd, project.path) && !isChannelSession(session)
                          )
                          return (
                            <ProjectGroup
                              key={project.path}
                              project={project}
                              sessions={projectSessions}
                              running={projectSessions.some((session) =>
                                runningSessionIds.has(session.id)
                              )}
                              activeSessionId={activeSessionId}
                              expanded={expanded}
                              onToggle={() =>
                                setProjectExpansion((current) => ({
                                  ...current,
                                  [path]: !expanded,
                                }))
                              }
                              projectActions={projectActions}
                              actions={sessionActions}
                            />
                          )
                        })}
                      </div>
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {imGroups.length > 0 ? (
                <>
                  <SidebarSectionHeader
                    title="IM 会话"
                    expanded={sectionExpansion.im}
                    summary={imGroups.reduce((total, group) => total + group.sessions.length, 0)}
                    running={runningIm}
                    onToggle={() => toggleSection("im")}
                    className="mt-4"
                  />
                  <AnimatePresence initial={false}>
                    {sectionExpansion.im ? (
                      <motion.div
                        key="im-section"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                          height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                          opacity: { duration: 0.14, ease: "easeOut" },
                        }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-0.5">
                          {imGroups.map((group) => (
                            <ImSessionGroup
                              key={group.connector}
                              group={group}
                              activeSessionId={activeSessionId}
                              actions={sessionActions}
                            />
                          ))}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </>
              ) : null}

              <SidebarSectionHeader
                title="最近"
                expanded={sectionExpansion.recent}
                summary={recentSessions.length}
                running={runningRecent}
                onToggle={() => toggleSection("recent")}
                actionLabel="新建最近会话"
                onAction={beginRecentNewConversation}
                className="mt-4"
              />
              <AnimatePresence initial={false}>
                {sectionExpansion.recent ? (
                  <motion.div
                    key="recent-section"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                      opacity: { duration: 0.14, ease: "easeOut" },
                    }}
                    className="overflow-hidden"
                  >
                    {recentSessions.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-sidebar-muted">暂无最近会话</p>
                    ) : (
                      <SessionList className="gap-0.5">
                        {recentSessions.map((session) => (
                          <div key={session.id}>
                            <SessionRow
                              session={session}
                              active={activeSessionId === session.id}
                              actions={sessionActions}
                              nested={false}
                            />
                          </div>
                        ))}
                      </SessionList>
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </>
          )}
        </ScrollArea>

        <DaemonAutoStartCard />

        <div className="flex min-w-0 items-center justify-between border-t border-sidebar-border/80 px-2 py-2">
          <Button
            type="button"
            variant="ghost"
            title="设置"
            aria-label="打开设置"
            onClick={onOpenSettings}
            className="flex-1 justify-start text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Settings />
            设置
          </Button>
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="手机"
              aria-label="手机"
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Smartphone />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={darkTheme ? "切换到浅色主题" : "切换到深色主题"}
              aria-label={darkTheme ? "切换到浅色主题" : "切换到深色主题"}
              onClick={() => setPreference("theme", nextExplicitTheme(resolvedTheme))}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {darkTheme ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </aside>

      {sessionActionsDialogs.dialogs}

      <Dialog
        open={renameProjectTarget !== null}
        onOpenChange={(value) => !value && setRenameProjectTarget(null)}
      >
        <DialogContent>
          <form onSubmit={submitProjectRename} className="contents">
            <DialogHeader>
              <DialogTitle>重命名项目</DialogTitle>
              <DialogDescription>只修改 Vykor 中显示的名称，不会重命名磁盘目录。</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <Label htmlFor="project-name">项目名称</Label>
                <Input
                  id="project-name"
                  name="name"
                  autoFocus
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  maxLength={80}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button type="submit" disabled={!projectName.trim() || busy}>
                {busy ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeProjectTarget !== null}
        onOpenChange={(value) => !value && setRemoveProjectTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从列表移除项目？</DialogTitle>
            <DialogDescription>
              “{removeProjectTarget?.name}
              ”将不再出现在项目列表中。磁盘目录和已有会话都会保留，之后可以重新选择该目录恢复项目。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">取消</Button>} />
            <Button variant="destructive" disabled={busy} onClick={confirmProjectRemove}>
              {busy ? "移除中..." : "从列表移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}
