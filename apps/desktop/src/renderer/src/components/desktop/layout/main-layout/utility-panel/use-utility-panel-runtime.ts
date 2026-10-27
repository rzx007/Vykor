import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react"

import type { BrowserToolTab } from "@renderer/components/desktop/tools/browser/browser-tool"
import type { FileViewerTab } from "@renderer/components/desktop/tools/files/file-viewer"

import {
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "./utility-panel-repository"
import type { UtilityPanelRuntimeState } from "./utility-panel-state"
import type { UtilityTab } from "./utility-panel-tabs"

export type CloseOrdinaryTabsAction = {
  type: "closeOrdinaryTabs"
  tabIds: string[]
  preferredActiveTabId?: string
  selectedProjectPath?: string
  appTabIds: string[]
}

export type UtilityPanelRuntimeAction =
  | CloseOrdinaryTabsAction
  | { type: "tabs"; value: SetStateAction<UtilityTab[]> }
  | { type: "browserTabs"; value: SetStateAction<BrowserToolTab[]> }
  | { type: "fileTabs"; value: SetStateAction<FileViewerTab[]> }
  | { type: "fileProjectPath"; value: SetStateAction<string | null> }
  | { type: "activeFilePath"; value: SetStateAction<string | null> }
  | { type: "loadingFilePath"; value: SetStateAction<string | null> }
  | { type: "activeTabId"; value: SetStateAction<string> }
  | { type: "terminalMounted"; value: SetStateAction<boolean> }
  | { type: "handledFileRequestId"; value: number | null }
  | { type: "handledToolRequestId"; value: number | null }
  | { type: "handledImageRequestId"; value: number | null }
  | { type: "handledTerminalRequestId"; value: number | null }
  | { type: "handledAppRequestId"; value: number | null }

function resolveState<T>(current: T, value: SetStateAction<T>): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value
}

export function utilityPanelRuntimeReducer(
  state: UtilityPanelRuntimeState,
  action: UtilityPanelRuntimeAction
): UtilityPanelRuntimeState {
  switch (action.type) {
    case "closeOrdinaryTabs": {
      const closingIds = new Set(action.tabIds.filter((id) => !id.startsWith("plugin-app:")))
      const closingFiles = state.tabs.filter((tab) => closingIds.has(tab.id) && tab.filePath)
      const tabs = state.tabs.filter((tab) => !closingIds.has(tab.id))
      const fileTabs = state.fileTabs.filter((file) => !closingFiles.some(
        (tab) => tab.filePath === file.preview.path && tab.projectPath === file.projectPath
      ))
      const visibleTabs = tabs.filter((tab) => !tab.projectPath || tab.projectPath === action.selectedProjectPath)
      const selectable = (id: string | undefined) => id && !closingIds.has(id) && (
        visibleTabs.some((tab) => tab.id === id) || action.appTabIds.includes(id)
      )
      const activeTabId = selectable(action.preferredActiveTabId)
        ? action.preferredActiveTabId!
        : selectable(state.activeTabId)
          ? state.activeTabId
          : (visibleTabs[0] ?? tabs[0])?.id ?? ""
      const activeTab = tabs.find((tab) => tab.id === activeTabId)
      const visibleFiles = fileTabs.filter((file) => (file.projectPath ?? null) === (action.selectedProjectPath ?? null))
      const activeFilePath = activeTab?.filePath ?? (
        visibleFiles.some((file) => file.preview.path === state.activeFilePath)
          ? state.activeFilePath : visibleFiles[0]?.preview.path ?? null
      )
      return {
        ...state, tabs, fileTabs, activeTabId, activeFilePath,
        browserTabs: state.browserTabs.filter((tab) => !closingIds.has(tab.id)),
        loadingFilePath: closingFiles.some((tab) => tab.filePath === state.loadingFilePath)
          ? null : state.loadingFilePath,
      }
    }
    case "tabs":
      return { ...state, tabs: resolveState(state.tabs, action.value) }
    case "browserTabs":
      return { ...state, browserTabs: resolveState(state.browserTabs, action.value) }
    case "fileTabs":
      return { ...state, fileTabs: resolveState(state.fileTabs, action.value) }
    case "fileProjectPath":
      return { ...state, fileProjectPath: resolveState(state.fileProjectPath, action.value) }
    case "activeFilePath":
      return { ...state, activeFilePath: resolveState(state.activeFilePath, action.value) }
    case "loadingFilePath":
      return { ...state, loadingFilePath: resolveState(state.loadingFilePath, action.value) }
    case "activeTabId":
      return { ...state, activeTabId: resolveState(state.activeTabId, action.value) }
    case "terminalMounted":
      return { ...state, terminalMounted: resolveState(state.terminalMounted, action.value) }
    case "handledFileRequestId":
      return { ...state, handledFileRequestId: action.value }
    case "handledToolRequestId":
      return { ...state, handledToolRequestId: action.value }
    case "handledImageRequestId":
      return { ...state, handledImageRequestId: action.value }
    case "handledTerminalRequestId":
      return { ...state, handledTerminalRequestId: action.value }
    case "handledAppRequestId":
      return { ...state, handledAppRequestId: action.value }
  }
}

export function defaultUtilityPanelRuntimeState(): UtilityPanelRuntimeState {
  return {
    tabs: [],
    browserTabs: [],
    fileTabs: [],
    fileProjectPath: null,
    activeFilePath: null,
    loadingFilePath: null,
    activeTabId: "",
    terminalMounted: false,
    handledFileRequestId: null,
    handledToolRequestId: null,
    handledTerminalRequestId: null,
  }
}

type UtilityPanelRuntimeController = {
  state: UtilityPanelRuntimeState
  fileTabsRef: React.MutableRefObject<FileViewerTab[]>
  closeOrdinaryTabs: (action: CloseOrdinaryTabsAction) => UtilityPanelRuntimeState
  setTabs: Dispatch<SetStateAction<UtilityTab[]>>
  setBrowserTabs: Dispatch<SetStateAction<BrowserToolTab[]>>
  setFileTabs: Dispatch<SetStateAction<FileViewerTab[]>>
  setFileProjectPath: Dispatch<SetStateAction<string | null>>
  setActiveFilePath: Dispatch<SetStateAction<string | null>>
  setLoadingFilePath: Dispatch<SetStateAction<string | null>>
  setActiveTabId: Dispatch<SetStateAction<string>>
  setTerminalMounted: Dispatch<SetStateAction<boolean>>
  setHandledFileRequestId: (requestId: number | null) => void
  setHandledToolRequestId: (requestId: number | null) => void
  setHandledImageRequestId: (requestId: number | null) => void
  setHandledTerminalRequestId: (requestId: number | null) => void
  setHandledAppRequestId: (requestId: number | null) => void
}

export function useUtilityPanelRuntime(scopeId: string): UtilityPanelRuntimeController {
  const [state, dispatch] = useReducer(
    utilityPanelRuntimeReducer,
    scopeId,
    (initialScopeId): UtilityPanelRuntimeState =>
      readUtilityPanelRuntimeState(initialScopeId) ?? defaultUtilityPanelRuntimeState()
  )
  const fileTabsRef = useRef(state.fileTabs)
  const stateRef = useRef(state)
  stateRef.current = state
  const closeOrdinaryTabs = useCallback((action: CloseOrdinaryTabsAction) => {
    const next = utilityPanelRuntimeReducer(stateRef.current, action)
    stateRef.current = next
    fileTabsRef.current = next.fileTabs
    dispatch(action)
    return next
  }, [])

  useEffect(() => {
    fileTabsRef.current = state.fileTabs
    writeUtilityPanelRuntimeState(scopeId, state)
  }, [scopeId, state])

  const setTabs = useCallback((value: SetStateAction<UtilityTab[]>) => {
    dispatch({ type: "tabs", value })
  }, [])
  const setBrowserTabs = useCallback((value: SetStateAction<BrowserToolTab[]>) => {
    dispatch({ type: "browserTabs", value })
  }, [])
  const setFileTabs = useCallback((value: SetStateAction<FileViewerTab[]>) => {
    dispatch({ type: "fileTabs", value })
  }, [])
  const setFileProjectPath = useCallback((value: SetStateAction<string | null>) => {
    dispatch({ type: "fileProjectPath", value })
  }, [])
  const setActiveFilePath = useCallback((value: SetStateAction<string | null>) => {
    dispatch({ type: "activeFilePath", value })
  }, [])
  const setLoadingFilePath = useCallback((value: SetStateAction<string | null>) => {
    dispatch({ type: "loadingFilePath", value })
  }, [])
  const setActiveTabId = useCallback((value: SetStateAction<string>) => {
    dispatch({ type: "activeTabId", value })
  }, [])
  const setTerminalMounted = useCallback((value: SetStateAction<boolean>) => {
    dispatch({ type: "terminalMounted", value })
  }, [])
  const setHandledFileRequestId = useCallback((value: number | null) => {
    dispatch({ type: "handledFileRequestId", value })
  }, [])
  const setHandledToolRequestId = useCallback((value: number | null) => {
    dispatch({ type: "handledToolRequestId", value })
  }, [])
  const setHandledImageRequestId = useCallback((value: number | null) => {
    dispatch({ type: "handledImageRequestId", value })
  }, [])
  const setHandledTerminalRequestId = useCallback((value: number | null) => {
    dispatch({ type: "handledTerminalRequestId", value })
  }, [])
  const setHandledAppRequestId = useCallback((value: number | null) => {
    dispatch({ type: "handledAppRequestId", value })
  }, [])

  return {
    state,
    fileTabsRef,
    closeOrdinaryTabs,
    setTabs,
    setBrowserTabs,
    setFileTabs,
    setFileProjectPath,
    setActiveFilePath,
    setLoadingFilePath,
    setActiveTabId,
    setTerminalMounted,
    setHandledFileRequestId,
    setHandledToolRequestId,
    setHandledImageRequestId,
    setHandledTerminalRequestId,
    setHandledAppRequestId,
  }
}
