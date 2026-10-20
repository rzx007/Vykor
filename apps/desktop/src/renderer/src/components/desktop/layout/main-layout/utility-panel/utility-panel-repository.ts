import {
  defaultUtilityPanelViewState,
  parsePersistedFileTabs,
  parseUtilityPanelViewStates,
  type PersistedFileTabsByScope,
  type UtilityPanelRuntimeState,
  type UtilityPanelViewState,
  type UtilityPanelViewStates,
} from "./utility-panel-state"

import { useCodePreviewDrafts } from "@renderer/components/desktop/tools/editor/code-preview-drafts"

const persistedViewStatesKey = "vykor.desktop.utility-panel-states"
const persistedFileTabsKey = "vykor.desktop.file-tabs"

/**
 * 每个 scope 的运行时状态都可能携带完整图片字节（`UtilityTab.imageSource` 的
 * `bytes: ArrayBuffer`），所以这个模块级缓存必须有硬上限：否则每访问一个新的
 * 会话/项目就会永久多留一份数据，且切走后不会释放。
 *
 * 采用「最近写入者保留」的 LRU：当前活动的 scope 每次状态变更都会重新写入，
 * 因此永远处于队尾、不会被淘汰。
 */
const maxRetainedRuntimeStates = 8

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
  // 先删后插，把该 scope 挪到 Map 的队尾，即「最近使用」。
  runtimeStates.delete(scopeId)
  runtimeStates.set(scopeId, state)
  while (runtimeStates.size > maxRetainedRuntimeStates) {
    const oldest = runtimeStates.keys().next()
    if (oldest.done) break
    runtimeStates.delete(oldest.value)
  }
}

/** 仅供测试：清空模块级缓存，避免用例之间互相干扰。 */
export function resetUtilityPanelRuntimeStatesForTests(): void {
  runtimeStates.clear()
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
  useCodePreviewDrafts.getState().moveScope(fromScopeId, toScopeId)

  let nextViewStates = viewStates
  if (!viewStates[toScopeId]) {
    const fromViewState = readUtilityPanelViewState(viewStates, fromScopeId)
    nextViewStates = { ...viewStates, [toScopeId]: fromViewState }
    delete nextViewStates[fromScopeId]
    writeUtilityPanelViewStates(nextViewStates)
  }

  // 无论目标 scope 是否已有状态，源 scope 都必须被回收：目标已有状态时，
  // 之前的分支会直接跳过，源 scope 的运行时状态（可能含图片字节）就永远留了下来。
  const runtimeState = runtimeStates.get(fromScopeId)
  if (runtimeState && !runtimeStates.has(toScopeId)) runtimeStates.set(toScopeId, runtimeState)
  runtimeStates.delete(fromScopeId)

  const fileTabs = readPersistedUtilityFileTabs()
  if (fileTabs[fromScopeId]) {
    const nextFileTabs = { ...fileTabs }
    if (!fileTabs[toScopeId]) nextFileTabs[toScopeId] = fileTabs[fromScopeId]!
    delete nextFileTabs[fromScopeId]
    writePersistedUtilityFileTabs(nextFileTabs)
  }

  return nextViewStates
}
