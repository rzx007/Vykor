import type { BrowserToolTab } from "@renderer/components/desktop/tools/browser-tool"
import type { FileViewerTab } from "@renderer/components/desktop/tools/file-viewer"

import type { UtilityTab } from "./utility-panel-tabs"

export type UtilityPanelLayout = Record<string, number>

export type UtilityPanelViewState = {
  open: boolean
  maximized: boolean
  layout: UtilityPanelLayout | null
}

export type UtilityPanelViewStates = Record<string, UtilityPanelViewState>

export type UtilityPanelRuntimeState = {
  tabs: UtilityTab[]
  browserTabs: BrowserToolTab[]
  fileTabs: FileViewerTab[]
  fileProjectPath: string | null
  activeFilePath: string | null
  loadingFilePath: string | null
  activeTabId: string
  terminalMounted: boolean
  handledFileRequestId: number | null
  handledToolRequestId: number | null
  handledImageRequestId?: number | null
}

export type PersistedFileTabsByScope = Record<
  string,
  {
    activePath: string | null
    paths: string[]
  }
>

export function createBrowserTab(
  id: string,
  url: string | null = null,
  title = "新标签页"
): BrowserToolTab {
  return {
    id,
    title,
    url,
    input: url ?? "",
    loading: url !== null,
    canGoBack: false,
    canGoForward: false,
  }
}

export function utilityPanelScopeId(
  activeSessionId: string | null,
  selectedProjectId: string | null
): string {
  if (activeSessionId) return `session:${activeSessionId}`
  return `draft:${selectedProjectId ?? "outside-project"}`
}

export function shouldMoveDraftPanelToSession(
  previousActiveSessionId: string | null,
  nextActiveSessionId: string | null,
  knownSessionIds: ReadonlySet<string>
): boolean {
  return (
    previousActiveSessionId === null &&
    nextActiveSessionId !== null &&
    !knownSessionIds.has(nextActiveSessionId)
  )
}

export function defaultUtilityPanelViewState(): UtilityPanelViewState {
  return {
    open: false,
    maximized: false,
    layout: null,
  }
}

export function parseUtilityPanelViewStates(raw: string | null): UtilityPanelViewStates {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const states: UtilityPanelViewStates = {}
    for (const [scopeId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const open = record.open === true
      const maximized = open && record.maximized === true
      states[scopeId] = {
        open,
        maximized,
        layout: parseLayout(record.layout),
      }
    }
    return states
  } catch {
    return {}
  }
}

export function parsePersistedFileTabs(raw: string | null): PersistedFileTabsByScope {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const result: PersistedFileTabsByScope = {}
    for (const [scopeId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const paths = Array.isArray(record.paths)
        ? record.paths.filter((path): path is string => typeof path === "string")
        : []
      const activePath = typeof record.activePath === "string" ? record.activePath : null
      if (paths.length > 0) result[scopeId] = { activePath, paths }
    }
    return result
  } catch {
    return {}
  }
}

function parseLayout(value: unknown): UtilityPanelLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const conversation = Number(record.conversation)
  const utility = Number(record.utility)
  if (!Number.isFinite(conversation) || !Number.isFinite(utility)) return null
  if (conversation <= 0 || utility <= 0) return null
  return { conversation, utility }
}
