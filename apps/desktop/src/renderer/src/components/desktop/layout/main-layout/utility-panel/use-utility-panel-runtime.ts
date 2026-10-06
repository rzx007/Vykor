import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react"

import type { BrowserToolTab } from "@renderer/components/desktop/tools/browser-tool"
import type { FileViewerTab } from "@renderer/components/desktop/tools/file-viewer"

import {
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "./utility-panel-repository"
import type { UtilityPanelRuntimeState } from "./utility-panel-state"
import type { UtilityTab } from "./utility-panel-tabs"

export type UtilityPanelRuntimeAction =
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

function resolveState<T>(current: T, value: SetStateAction<T>): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value
}

export function utilityPanelRuntimeReducer(
  state: UtilityPanelRuntimeState,
  action: UtilityPanelRuntimeAction
): UtilityPanelRuntimeState {
  switch (action.type) {
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
  }
}

type UtilityPanelRuntimeController = {
  state: UtilityPanelRuntimeState
  fileTabsRef: React.MutableRefObject<FileViewerTab[]>
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
}

export function useUtilityPanelRuntime(scopeId: string): UtilityPanelRuntimeController {
  const [state, dispatch] = useReducer(
    utilityPanelRuntimeReducer,
    scopeId,
    (initialScopeId): UtilityPanelRuntimeState =>
      readUtilityPanelRuntimeState(initialScopeId) ?? defaultUtilityPanelRuntimeState()
  )
  const fileTabsRef = useRef(state.fileTabs)

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

  return {
    state,
    fileTabsRef,
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
  }
}
