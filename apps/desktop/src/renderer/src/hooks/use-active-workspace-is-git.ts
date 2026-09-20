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
 *
 * 探测结果连同它对应的路径一起存储，返回时只有路径匹配才采用：切换工作区后
 * 立即回到 null，不会把上一个目录的判定结果泄漏给新目录；并发的旧探测即使较晚
 * resolve，也会因路径不匹配（以及 cleanup 的 cancelled 标志）被丢弃。
 */
export function useActiveWorkspaceIsGit(): boolean | null {
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const isProjectSession = useDesktopSessionStore((state) => state.selectedProject !== null)
  const workspacePath = workspaceProject?.path ?? null
  const [probed, setProbed] = useState<{ path: string; value: boolean } | null>(null)

  useEffect(() => {
    if (isProjectSession || !workspacePath) return
    let cancelled = false
    void probeWorkspaceGit(workspacePath).then((value) => {
      if (!cancelled) setProbed({ path: workspacePath, value })
    })
    return () => {
      cancelled = true
    }
  }, [isProjectSession, workspacePath])

  if (isProjectSession) return selectedProjectGit
  if (!workspacePath) return false
  if (probed?.path !== workspacePath) return null
  return probed.value
}
