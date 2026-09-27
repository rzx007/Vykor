export const SIDEBAR_DEFAULT_WIDTH_PX = 288
export const SIDEBAR_MIN_WIDTH_PX = 266
export const SIDEBAR_MAX_WIDTH_PX = 420

const SIDEBAR_WIDTH_STORAGE_KEY = "vykor.desktop.workspace-sidebar-width-px"

export function clampSidebarWidthPx(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH_PX
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width)))
}

export function readStoredSidebarWidthPx(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return clampSidebarWidthPx(parsed)
  } catch {
    return null
  }
}

export function persistSidebarWidthPx(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidthPx(width)))
  } catch {
    // Sidebar width is best-effort UI state and must never interrupt the desktop app.
  }
}

export function resolveSidebarDefaultWidthPx(): number {
  return readStoredSidebarWidthPx() ?? SIDEBAR_DEFAULT_WIDTH_PX
}

export function shouldPersistSidebarWidth(
  meta: { isUserInteraction: boolean },
  inPixels: number
): boolean {
  return meta.isUserInteraction && Number.isFinite(inPixels) && inPixels > 1
}
