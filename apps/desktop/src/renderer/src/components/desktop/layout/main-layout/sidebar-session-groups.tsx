import { FolderClosed, FolderOpen, FolderSync, MoreHorizontal, Pencil, Pin, PinOff, Smartphone, SquarePen, Trash2 } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import type * as React from "react"
import { Fragment, useRef, useState } from "react"
import { SharedLayoutBg } from "@renderer/components/motion/shared-layout-bg"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { isSessionPinned, useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopImSessionGroup } from "@renderer/stores/desktop-session/selectors"
import type { DesktopProject, DesktopSessionRecord } from "@shared/session-types"
import { SessionMoreMenu } from "../../conversation-page/session/session-more-menu"
import { projectMenuItems } from "./project-menu-items"
import { SidebarSectionLabel } from "./sidebar-controls"

export type SessionActions = {
  onOpen: (session: DesktopSessionRecord) => void
  onRename: (session: DesktopSessionRecord) => void
  onArchive: (session: DesktopSessionRecord) => void
  onDelete: (session: DesktopSessionRecord) => void
}

export type ProjectActions = {
  onNewConversation: (project: DesktopProject) => void
  onRename: (project: DesktopProject) => void
  onTogglePin: (project: DesktopProject) => void
  onRemove: (project: DesktopProject) => void
  onRebind: (project: DesktopProject) => void
}

function handleProjectMenuItem(id: string, project: DesktopProject, actions: ProjectActions): void {
  switch (id) {
    case "pin":
      actions.onTogglePin(project)
      return
    case "reveal":
      void window.desktop.workspace.revealPath({ rootPath: project.path, path: "." })
      return
    case "rebind":
      actions.onRebind(project)
      return
    case "rename":
      actions.onRename(project)
      return
    case "remove":
      actions.onRemove(project)
  }
}

function projectMenuIcon(id: string, pinned: boolean): React.JSX.Element {
  switch (id) {
    case "pin":
      return pinned ? <PinOff /> : <Pin />
    case "reveal":
      return <FolderOpen />
    case "rebind":
      return <FolderSync />
    case "rename":
      return <Pencil />
    case "remove":
      return <Trash2 />
    default:
      return <></>
  }
}

export function SessionRow({
  session,
  active,
  actions,
  archived = false,
  nested = true,
}: {
  session: DesktopSessionRecord
  active: boolean
  actions: SessionActions
  archived?: boolean
  nested?: boolean
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pinned = isSessionPinned(session)
  const activity = useDesktopSessionStore((state) => state.activity.sessions[session.id])
  const running =
    !archived &&
    (activity?.executionState === "running" || (!activity && session.status === "running"))
  const title = sessionTitle(session)

  return (
    <div
      className="group/session relative flex min-w-0 items-center"
      onContextMenu={(event) => {
        event.preventDefault()
        triggerRef.current?.click()
      }}
    >
      <button
        type="button"
        onClick={() => actions.onOpen(session)}
        className={cn(
          "text-ui-small relative h-7.5 min-w-0 flex-1 truncate rounded-md pr-12 text-left leading-7.5 font-normal transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          nested ? "pl-8" : "pl-2.5",
          active
            ? "bg-sidebar-selected text-sidebar-foreground"
            : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        )}
      >
        {pinned ? <Pin className="mr-1 inline size-3 -translate-y-px text-sidebar-muted" /> : null}
        {title}
        {!archived && !active && activity ? <SessionActivityIndicator activity={activity} /> : null}
      </button>
      <SessionMoreMenu
        session={session}
        archived={archived}
        align="end"
        triggerRef={triggerRef}
        trigger={
          <button
            type="button"
            aria-label={running ? `${title} 正在运行，打开更多操作` : `管理会话 ${title}`}
            title={running ? "会话运行中" : "更多操作"}
            className={cn(
              "absolute right-1 grid size-6 place-items-center rounded text-sidebar-muted transition-opacity outline-none hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent data-popup-open:opacity-100 [&_svg]:size-3.5",
              running ? "opacity-100" : "opacity-0 group-hover/session:opacity-100"
            )}
          />
        }
        onRename={() => actions.onRename(session)}
        onArchive={() => actions.onArchive(session)}
        onDelete={() => actions.onDelete(session)}
      >
        {running ? (
          <>
            <Spinner
              aria-hidden="true"
              className="size-3.5 group-hover/session:hidden in-data-popup-open:hidden"
            />
            <MoreHorizontal className="hidden group-hover/session:inline in-data-popup-open:inline" />
          </>
        ) : (
          <MoreHorizontal />
        )}
      </SessionMoreMenu>
    </div>
  )
}

export function SessionList({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <SharedLayoutBg inset={0} pillClassName="rounded-md bg-sidebar-accent" className={className}>
      {children}
    </SharedLayoutBg>
  )
}

export function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  expanded,
  running,
  onToggle,
  projectActions,
  actions,
}: {
  project: DesktopProject
  sessions: DesktopSessionRecord[]
  activeSessionId: string | null
  expanded: boolean
  running: boolean
  onToggle: () => void
  projectActions: ProjectActions
  actions: SessionActions
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const visibleSessions = showAll ? sessions : sessions.slice(0, 5)

  return (
    <section>
      <DropdownMenu>
        <div
          className="group/project relative flex min-w-0 items-center"
          onContextMenu={(event) => {
            event.preventDefault()
            triggerRef.current?.click()
          }}
        >
          <button
            type="button"
            title={project.path}
            aria-expanded={expanded}
            onClick={onToggle}
            aria-label={`${project.name}${!expanded && sessions.length > 0 ? `，${sessions.length} 个对话` : ""}`}
            className="text-ui-small flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 pr-8 text-left font-[450] text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {expanded ? (
              <FolderOpen className="size-3.75 shrink-0 text-sidebar-muted" strokeWidth={1.7} />
            ) : (
              <FolderClosed className="size-3.75 shrink-0 text-sidebar-muted" strokeWidth={1.7} />
            )}
            <span className="truncate">{project.name}</span>
            {!expanded && running ? (
              <Spinner
                role="img"
                aria-label={`${project.name}，有会话正在运行`}
                className="ml-auto size-3 motion-reduce:animate-none"
              />
            ) : null}
            {!expanded && sessions.length > 0 ? (
              <span
                className={cn(
                  "text-ui-caption shrink-0 text-sidebar-muted",
                  !running && !project.pinnedAt && "ml-auto"
                )}
              >
                {sessions.length}
              </span>
            ) : null}
            {!project.available ? (
              <span className="text-ui-caption shrink-0 font-normal text-amber-600">
                目录不可用
              </span>
            ) : null}
            {project.pinnedAt ? (
              <Pin
                className={cn(
                  "size-3 shrink-0 text-sidebar-muted",
                  !running && sessions.length === 0 && "ml-auto"
                )}
              />
            ) : null}
          </button>
          <DropdownMenuTrigger
            ref={triggerRef}
            aria-label={`管理项目 ${project.name}`}
            title="更多操作"
            className="absolute right-7 grid size-6 place-items-center rounded text-sidebar-muted opacity-0 transition-opacity outline-none group-hover/project:opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent data-popup-open:opacity-100 [&_svg]:size-3.5"
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <button
            type="button"
            aria-label={`在项目 ${project.name} 中新建会话`}
            title="新建会话"
            onClick={() => projectActions.onNewConversation(project)}
            className="absolute right-1 grid size-6 place-items-center rounded text-sidebar-muted opacity-0 transition-opacity outline-none group-hover/project:opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SquarePen className="size-3.5" />
          </button>
        </div>
        <DropdownMenuContent align="start" className="min-w-56">
          {projectMenuItems(Boolean(project.pinnedAt)).map((item) => (
            <Fragment key={item.id}>
              {item.id === "remove" ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                variant={item.id === "remove" ? "destructive" : undefined}
                onClick={() => handleProjectMenuItem(item.id, project, projectActions)}
              >
                {projectMenuIcon(item.id, Boolean(project.pinnedAt))}
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AnimatePresence initial={false}>
        {expanded && sessions.length > 0 ? (
          <motion.div
            key="project-history"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.14, ease: "easeOut" },
            }}
            className="overflow-hidden"
          >
            <div className="pb-1">
              <SessionList>
                {visibleSessions.map((session) => (
                  <div key={session.id}>
                    <SessionRow
                      session={session}
                      active={activeSessionId === session.id}
                      actions={actions}
                    />
                  </div>
                ))}
              </SessionList>
              {sessions.length > 5 ? (
                <button
                  type="button"
                  onClick={() => setShowAll((current) => !current)}
                  className="flex h-7 w-full items-center rounded-md pr-2 pl-8 text-left text-xs font-normal text-sidebar-muted/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {showAll ? "收起" : "展开显示"}
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  )
}

export function ImSessionGroup({
  group,
  activeSessionId,
  actions,
}: {
  group: DesktopImSessionGroup
  activeSessionId: string | null
  actions: SessionActions
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const visibleSessions = showAll ? group.sessions : group.sessions.slice(0, 5)

  return (
    <section>
      <div className="text-ui-small flex h-7.5 min-w-0 items-center gap-2 px-2.5 font-[450] text-sidebar-foreground/90">
        <Smartphone className="size-3.75 shrink-0 text-sidebar-muted" strokeWidth={1.7} />
        <span className="truncate">{group.label}</span>
        <span className="text-ui-caption ml-auto shrink-0 font-normal text-sidebar-muted/70">
          {group.sessions.length}
        </span>
      </div>
      <div className="pb-1">
        <SessionList>
          {visibleSessions.map((session) => (
            <div key={session.id}>
              <SessionRow
                session={session}
                active={activeSessionId === session.id}
                actions={actions}
              />
            </div>
          ))}
        </SessionList>
        {group.sessions.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            className="flex h-7 w-full items-center rounded-md pr-2 pl-8 text-left text-xs font-normal text-sidebar-muted/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {showAll ? "收起" : "展开显示"}
          </button>
        ) : null}
      </div>
    </section>
  )
}

export function ArchivedSessionList({
  sessions,
  activeSessionId,
  actions,
}: {
  sessions: DesktopSessionRecord[]
  activeSessionId: string | null
  actions: SessionActions
}): React.JSX.Element {
  return (
    <section>
      <SidebarSectionLabel>已归档</SidebarSectionLabel>
      {sessions.length === 0 ? (
        <p className="px-2.5 py-2 text-xs leading-5 text-sidebar-muted">还没有归档的会话。</p>
      ) : (
        <SessionList>
          {sessions.map((session) => (
            <div key={session.id}>
              <SessionRow
                session={session}
                active={activeSessionId === session.id}
                actions={actions}
                archived
                nested={false}
              />
            </div>
          ))}
        </SessionList>
      )}
    </section>
  )
}

function SessionActivityIndicator({
  activity,
}: {
  activity: import("@shared/activity-types").DesktopSessionActivity
}): React.JSX.Element | null {
  const status = activity.executionState
  const indicator =
    status === "needs_input"
      ? { label: "等待处理", color: "bg-amber-600" }
      : (status === "failed" || status === "interrupted") && activity.attentionState === "unread"
        ? { label: status === "failed" ? "运行失败" : "运行中断", color: "bg-destructive" }
        : status === "completed" && activity.attentionState === "unread"
          ? { label: "有新结果", color: "bg-primary" }
          : null
  if (!indicator) return null
  return (
    <span
      role="img"
      aria-label={indicator.label}
      className={cn(
        "pointer-events-none absolute top-1/2 right-8 size-2 -translate-y-1/2 rounded-full",
        indicator.color
      )}
    />
  )
}

function sessionTitle(session: DesktopSessionRecord): string {
  const title = session.title.trim()
  return title && title !== "TUI" ? title : "新对话"
}
