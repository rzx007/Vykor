import {
  defaultUtilityPanelViewState,
  parsePersistedFileTabs,
  parseUtilityPanelViewStates,
  type PersistedFileTabsByScope,
  type UtilityPanelRuntimeState,
  type UtilityPanelViewState,
  type UtilityPanelViewStates,
} from "./utility-panel-state"

const persistedViewStatesKey = "vykor.desktop.utility-panel-states"
const persistedFileTabsKey = "vykor.desktop.file-tabs"
const runtimeStates = new Map<string, UtilityPanelRuntimeState>()

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Panel restoration is best-effort UI state and must never interrupt the desktop app.
  }
}

export function readUtilityPanelViewStates(): UtilityPanelViewStates {
  return parseUtilityPanelViewStates(readStorage(persistedViewStatesKey))
}

export function readUtilityPanelViewState(
  states: UtilityPanelViewStates,
  scopeId: string
): UtilityPanelViewState {
  return states[scopeId] ?? defaultUtilityPanelViewState()
}

export function writeUtilityPanelViewStates(states: UtilityPanelViewStates): void {
  writeStorage(persistedViewStatesKey, states)
}

export function patchUtilityPanelViewState(
  states: UtilityPanelViewStates,
  scopeId: string,
  patch: Partial<UtilityPanelViewState>
): UtilityPanelViewStates {
  const current = readUtilityPanelViewState(states, scopeId)
  return { ...states, [scopeId]: { ...current, ...patch } }
}

export function readUtilityPanelRuntimeState(
  scopeId: string
): UtilityPanelRuntimeState | undefined {
  return runtimeStates.get(scopeId)
}

export function writeUtilityPanelRuntimeState(
  scopeId: string,
  state: UtilityPanelRuntimeState
): void {
  runtimeStates.set(scopeId, state)
}

export function readPersistedUtilityFileTabs(): PersistedFileTabsByScope {
  return parsePersistedFileTabs(readStorage(persistedFileTabsKey))
}

export function writePersistedUtilityFileTabs(state: PersistedFileTabsByScope): void {
  writeStorage(persistedFileTabsKey, state)
}

export function moveUtilityPanelScope(
  fromScopeId: string,
  toScopeId: string,
  viewStates: UtilityPanelViewStates
): UtilityPanelViewStates {
  if (fromScopeId === toScopeId) return viewStates

  let nextViewStates = viewStates
  if (!viewStates[toScopeId]) {
    const fromViewState = readUtilityPanelViewState(viewStates, fromScopeId)
    nextViewStates = { ...viewStates, [toScopeId]: fromViewState }
    delete nextViewStates[fromScopeId]
    writeUtilityPanelViewStates(nextViewStates)
  }

  if (!runtimeStates.has(toScopeId)) {
    const runtimeState = runtimeStates.get(fromScopeId)
    if (runtimeState) {
      runtimeStates.set(toScopeId, runtimeState)
      runtimeStates.delete(fromScopeId)
    }
  }

  const fileTabs = readPersistedUtilityFileTabs()
  if (fileTabs[fromScopeId] && !fileTabs[toScopeId]) {
    const nextFileTabs = { ...fileTabs, [toScopeId]: fileTabs[fromScopeId] }
    delete nextFileTabs[fromScopeId]
    writePersistedUtilityFileTabs(nextFileTabs)
  }

  return nextViewStates
}
