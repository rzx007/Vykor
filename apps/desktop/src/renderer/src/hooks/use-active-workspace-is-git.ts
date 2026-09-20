import { useEffect, useState } from "react"

import { probeWorkspaceGit } from "@renderer/lib/workspace-git-probe"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"

/**
 * 当前右侧面板/对话使用的目录是不是 git 仓库。
 *
 * - 项目会话：直接取 store 的 selectedProjectGit（分支选择器语义），不额外探测。
 * - 项目外会话：对工作区路径（会话 cwd）做只读探测，结果带 TTL 缓存。
 *
 * 返回 null 表示尚未判定，调用方应只在 === true 时启用审阅。
 */
export function useActiveWorkspaceIsGit(): boolean | null {
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const isProjectSession = useDesktopSessionStore((state) => state.selectedProject !== null)
  const workspacePath = workspaceProject?.path ?? null
  const [probed, setProbed] = useState<boolean | null>(null)

  useEffect(() => {
    if (isProjectSession || !workspacePath) {
      setProbed(null)
      return
    }
    let cancelled = false
    void probeWorkspaceGit(workspacePath).then((value) => {
      if (!cancelled) setProbed(value)
    })
    return () => {
      cancelled = true
    }
  }, [isProjectSession, workspacePath])

  if (isProjectSession) return selectedProjectGit
  if (!workspacePath) return false
  return probed
}
