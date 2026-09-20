import type { DesktopSessionRun } from "@shared/session-types"

export function selectRunNotices(runs: readonly DesktopSessionRun[]): DesktopSessionRun[] {
  return runs.filter(
    (run) =>
      run.status === "failed" || (run.status === "interrupted" && run.metadata.stalled === true)
  )
}
