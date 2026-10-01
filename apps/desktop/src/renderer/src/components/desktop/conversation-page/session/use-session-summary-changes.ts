import { useEffect, useRef, useState } from "react"

import { queryGitChanges } from "@renderer/lib/git-changes-query"
import type { DesktopGitChangesResult } from "@shared/git-types"

type ChangesState =
  | { status: "loading"; result?: undefined; error?: undefined }
  | { status: "ready"; result: DesktopGitChangesResult; error?: undefined }
  | { status: "error"; result?: undefined; error: string }

export function useSessionSummaryChanges({
  open,
  rootPath,
  enabled,
  revision,
}: {
  open: boolean
  rootPath: string | undefined
  enabled: boolean
  revision: string
}) {
  const [state, setState] = useState<ChangesState>({ status: "loading" })
  const [refreshId, setRefreshId] = useState(0)
  const loadedRevision = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !enabled || !rootPath) return
    let cancelled = false
    const changed = loadedRevision.current !== null && loadedRevision.current !== revision
    const timer = window.setTimeout(
      () => {
        setState({ status: "loading" })
        void queryGitChanges({ rootPath, scope: "uncommitted" }, { force: true }).then(
          (result) => {
            if (cancelled) return
            loadedRevision.current = revision
            setState({ status: "ready", result })
          },
          (error: unknown) => {
            if (!cancelled)
              setState({
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              })
          }
        )
      },
      changed ? 300 : 0
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, rootPath, enabled, revision, refreshId])

  return { ...state, refresh: () => setRefreshId((current) => current + 1) }
}
