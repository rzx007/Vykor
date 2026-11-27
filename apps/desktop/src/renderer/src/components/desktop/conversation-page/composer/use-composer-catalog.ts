import { useEffect, useState } from "react"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopComposerCatalog } from "@shared/session-types"

export function useComposerCatalog(cwd: string | null, enabled = true, sessionId?: string) {
  const [snapshot, setSnapshot] = useState<
    (DesktopComposerCatalog & { cwd: string; sessionId?: string; error?: string }) | null
  >(null)

  useEffect(() => {
    if (!cwd || !enabled) return
    let cancelled = false
    // Give React's development-mode effect cleanup a chance to discard the first load.
    queueMicrotask(() => {
      if (cancelled) return
      const state = useDesktopSessionStore.getState()
      if (sessionId && state.activeSessionId !== sessionId) return
      const request = sessionId
        ? window.desktop.sessions.getComposerCatalog(cwd, sessionId)
        : window.desktop.sessions.getComposerCatalog(cwd)
      if (sessionId) {
        void state.refreshContextUsage({
          fromCatalog: request.then(
            ({ contextUsage }) => cancelled ? null : contextUsage,
            () => cancelled ? null : undefined
          ),
        })
      }
      void request.then(
        (catalog) => {
          if (!cancelled) setSnapshot({ cwd, sessionId, ...catalog })
        },
        () => {
          if (!cancelled) {
            setSnapshot({ cwd, sessionId, commands: [], plugins: [], error: "命令或插件列表暂时无法加载，请稍后重试。" })
          }
        }
      )
    })
    return () => {
      cancelled = true
    }
  }, [cwd, enabled, sessionId])

  return snapshot?.cwd === cwd && (!snapshot.error || snapshot.sessionId === sessionId) ? snapshot : null
}
