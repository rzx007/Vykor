import {
  Archive,
  Copy,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { isSessionPinned, useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopSessionRecord } from "@shared/session-types"

export function SessionMoreMenu({
  session,
  archived = false,
  align = "start",
  trigger,
  triggerRef,
  children,
  onRename,
  onArchive,
  onDelete,
}: {
  session: DesktopSessionRecord
  archived?: boolean
  align?: "start" | "end"
  trigger?: React.ReactElement
  triggerRef?: React.ComponentProps<typeof DropdownMenuTrigger>["ref"]
  children?: ReactNode
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
}): React.JSX.Element {
  const pinned = isSessionPinned(session)
  const togglePinSession = useDesktopSessionStore((state) => state.togglePinSession)
  const startConversationFrom = useDesktopSessionStore((state) => state.startConversationFrom)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)

  const copyText = (value: string): void => {
    void window.desktop.clipboard.writeText(value)
  }

  const revealProject = (): void => {
    void window.desktop.workspace.revealPath({ rootPath: session.cwd, path: "." })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        render={
          trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="更多操作"
              title="更多操作"
              className="text-muted-foreground"
            />
          )
        }
      >
        {children ?? <MoreHorizontal />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} sideOffset={8} className="min-w-64">
        {!archived ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void togglePinSession(session.id)}>
                {pinned ? <PinOff /> : <Pin />}
                {pinned ? "取消置顶聊天" : "置顶聊天"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <Pencil />
                重命名聊天
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onArchive}>
                <Archive />
                归档聊天
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Copy />
              复制
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              <DropdownMenuItem onClick={() => copyText(sessionTitle(session))}>
                复制标题
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => copyText(session.cwd)}>
                复制工作目录
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {!archived ? (
            <DropdownMenuItem onClick={() => void forkSession(session.id)}>
              <GitBranch />
              创建会话分支
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void startConversationFrom(session)}>
            <GitBranchPlus />
            基于此配置开始新会话
          </DropdownMenuItem>
          <DropdownMenuItem onClick={revealProject}>
            <FolderOpen />
            在资源管理器中打开
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            删除会话
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function sessionTitle(session: DesktopSessionRecord): string {
  const title = session.title.trim()
  return title && title !== "TUI" ? title : "新对话"
}
