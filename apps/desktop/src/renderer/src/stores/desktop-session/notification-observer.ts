import type { DesktopNotificationMode } from "@shared/settings-types"
import type {
  DesktopPermissionRequest,
  DesktopSessionRun,
  DesktopSessionView,
} from "@shared/session-types"

export async function notifyForSessionViewChange(input: {
  previous: DesktopSessionView | null
  next: DesktopSessionView
}): Promise<void> {
  if (!input.previous) return

  const notification = findSessionNotification(input.previous, input.next)
  if (!notification) return

  const mode = await readNotificationMode()
  if (mode === "never") return

  await window.desktop.tray.notify({
    ...notification,
    ...(mode === "always" ? { showWhenFocused: true } : {}),
  })
}

function findSessionNotification(
  previous: DesktopSessionView,
  next: DesktopSessionView
): { title: string; body: string } | null {
  const previousRuns = new Map(previous.runs.map((run) => [run.id, run]))
  for (const nextRun of next.runs) {
    const previousRun = previousRuns.get(nextRun.id)
    if (!previousRun || !isActiveRun(previousRun) || !isTerminalRun(nextRun)) continue
    if (nextRun.status === "completed") {
      return {
        title: "Vykor",
        body: `${sessionTitle(next)} 已完成。`,
      }
    }
    if (nextRun.status === "failed") {
      return {
        title: "Vykor",
        body: `${sessionTitle(next)} 运行失败。`,
      }
    }
  }

  const previousPendingPermissionIds = new Set(
    previous.permissions
      .filter((permission) => permission.status === "pending")
      .map((permission) => permission.id)
  )
  const permission = next.permissions.find(
    (candidate) => candidate.status === "pending" && !previousPendingPermissionIds.has(candidate.id)
  )
  if (permission) {
    return {
      title: "Vykor 需要处理",
      body: `${sessionTitle(next)} 正在等待 ${permissionToolName(permission)} 授权。`,
    }
  }

  return null
}

async function readNotificationMode(): Promise<DesktopNotificationMode> {
  try {
    return (await window.desktop.settings.snapshot()).notificationMode
  } catch {
    return "when_unfocused"
  }
}

function isActiveRun(run: DesktopSessionRun): boolean {
  return run.status === "pending" || run.status === "running"
}

function isTerminalRun(run: DesktopSessionRun): boolean {
  return run.status === "completed" || run.status === "failed"
}

function sessionTitle(view: DesktopSessionView): string {
  const title = view.session.title.trim()
  return title && title !== "TUI" ? title : "当前任务"
}

function permissionToolName(permission: DesktopPermissionRequest): string {
  return permission.toolName.trim() || "工具"
}
