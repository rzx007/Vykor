import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type {
  GroupImperativeHandle,
  Layout,
  PanelImperativeHandle,
} from "react-resizable-panels"

import { beginPanelToggleTransition } from "../panel-toggle-transition"
import type { UtilityToolRequest } from "./utility-panel-tabs"
import {
  moveUtilityPanelScope,
  patchUtilityPanelViewState,
  readUtilityPanelViewState,
  readUtilityPanelViewStates,
  writeUtilityPanelViewStates,
} from "./utility-panel-repository"
import {
  shouldMoveDraftPanelToSession,
  utilityPanelScopeId,
  type UtilityPanelViewState,
  type UtilityPanelViewStates,
} from "./utility-panel-state"

type ScopedFileRequest = {
  id: number
  scopeId: string
  path: string
  line?: number
}

type ScopedTerminalRequest = {
  id: number
  scopeId: string
  terminalId: string
}

type ScopedToolRequest = {
  id: number
  scopeId: string
  tool: UtilityToolRequest
}

type ScopedReviewRequest = {
  id: number
  scopeId: string
  path?: string
}

type UseUtilityPanelControllerOptions = {
  activeSessionId: string | null
  selectedProjectId: string | null
  sessionIds: string[]
  defaultLayout: Layout
  collapsedLayout: Layout
  conversationPanelRef: RefObject<PanelImperativeHandle | null>
  utilityPanelRef: RefObject<PanelImperativeHandle | null>
  workspaceGroupRef: RefObject<GroupImperativeHandle | null>
  groupElementRef: RefObject<HTMLDivElement | null>
  onCollapseSidebar: () => void
}

export type UtilityPanelController = {
  scopeId: string
  instanceKey: string
  open: boolean
  maximized: boolean
  visibleLayout: Layout
  fileOpenRequest: Omit<ScopedFileRequest, "scopeId"> | null
  terminalOpenRequest: Omit<ScopedTerminalRequest, "scopeId"> | null
  toolOpenRequest: Omit<ScopedToolRequest, "scopeId"> | null
  reviewOpenRequest: Omit<ScopedReviewRequest, "scopeId"> | null
  restore: () => void
  collapse: () => void
  toggle: () => void
  toggleMaximized: () => void
  openFile: (path: string, line?: number) => void
  openReview: (path?: string) => void
  openTerminal: (terminalId: string) => void
  openTool: (tool: UtilityToolRequest) => void
  handleLayoutChanged: (layout: Layout) => void
  handlePanelResize: (sizeInPixels: number) => void
}

function isOpenLayout(layout: Layout | null | undefined): layout is Layout {
  return Number(layout?.conversation) > 5 && Number(layout?.utility) > 5
}

export function useUtilityPanelController({
  activeSessionId,
  selectedProjectId,
  sessionIds,
  defaultLayout,
  collapsedLayout,
  conversationPanelRef,
  utilityPanelRef,
  workspaceGroupRef,
  groupElementRef,
  onCollapseSidebar,
}: UseUtilityPanelControllerOptions): UtilityPanelController {
  const scopeId = utilityPanelScopeId(activeSessionId, selectedProjectId)
  const [initialState] = useState(() => {
    const states = readUtilityPanelViewStates()
    return { states, view: readUtilityPanelViewState(states, scopeId) }
  })
  const panelStatesRef = useRef<UtilityPanelViewStates>(initialState.states)
  const activeScopeIdRef = useRef(scopeId)
  const previousActiveSessionIdRef = useRef(activeSessionId)
  const knownSessionIdsRef = useRef(new Set(sessionIds))
  const previousLayoutRef = useRef<Layout | null>(null)
  const lastOpenLayoutRef = useRef<Layout | null>(initialState.view.layout)
  const [instanceRevision, setInstanceRevision] = useState(0)
  const [stateScopeId, setStateScopeId] = useState(scopeId)
  const [open, setOpen] = useState(initialState.view.open)
  const [maximized, setMaximized] = useState(initialState.view.maximized)
  const [layout, setLayout] = useState<Layout | null>(initialState.view.layout)
  const [fileRequest, setFileRequest] = useState<ScopedFileRequest | null>(null)
  const [terminalRequest, setTerminalRequest] = useState<ScopedTerminalRequest | null>(null)
  const [toolRequest, setToolRequest] = useState<ScopedToolRequest | null>(null)
  const [reviewRequest, setReviewRequest] = useState<ScopedReviewRequest | null>(null)

  const toggleTransitionCancelRef = useRef<(() => void) | null>(null)

  const runAnimatedLayoutChange = useCallback(
    (apply: () => void): void => {
      toggleTransitionCancelRef.current?.()
      toggleTransitionCancelRef.current = beginPanelToggleTransition(groupElementRef.current)
      apply()
    },
    [groupElementRef]
  )

  useEffect(
    () => () => {
      toggleTransitionCancelRef.current?.()
      toggleTransitionCancelRef.current = null
    },
    []
  )

  if (lastOpenLayoutRef.current === null) lastOpenLayoutRef.current = defaultLayout

  const persistActiveView = useCallback((patch: Partial<UtilityPanelViewState>): void => {
    const currentScopeId = activeScopeIdRef.current
    const nextStates = patchUtilityPanelViewState(panelStatesRef.current, currentScopeId, patch)
    panelStatesRef.current = nextStates
    writeUtilityPanelViewStates(nextStates)
  }, [])

  useEffect(() => {
    if (stateScopeId !== activeScopeIdRef.current) return
    persistActiveView({ open, maximized: open && maximized })
  }, [maximized, open, persistActiveView, stateScopeId])

  useLayoutEffect(() => {
    if (activeScopeIdRef.current === scopeId) return

    toggleTransitionCancelRef.current?.()
    toggleTransitionCancelRef.current = null

    const previousScopeId = activeScopeIdRef.current
    const createdSessionFromDraft = shouldMoveDraftPanelToSession(
      previousActiveSessionIdRef.current,
      activeSessionId,
      knownSessionIdsRef.current
    )
    if (createdSessionFromDraft) {
      panelStatesRef.current = moveUtilityPanelScope(
        previousScopeId,
        scopeId,
        panelStatesRef.current
      )
      setInstanceRevision((current) => current + 1)
    }

    activeScopeIdRef.current = scopeId
    const nextView = readUtilityPanelViewState(panelStatesRef.current, scopeId)
    const nextLayout = nextView.layout ?? defaultLayout
    lastOpenLayoutRef.current = nextLayout
    previousLayoutRef.current = null
    setStateScopeId(scopeId)
    setLayout(nextLayout)
    setOpen(nextView.open)
    setMaximized(nextView.maximized)

    const frame = window.requestAnimationFrame(() => {
      const group = workspaceGroupRef.current
      if (nextView.maximized) {
        utilityPanelRef.current?.expand()
        conversationPanelRef.current?.collapse()
        group?.setLayout({ conversation: 0, utility: 100 })
        return
      }

      conversationPanelRef.current?.expand()
      if (nextView.open) {
        utilityPanelRef.current?.expand()
        group?.setLayout(nextLayout)
      } else {
        utilityPanelRef.current?.collapse()
        group?.setLayout(collapsedLayout)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeSessionId,
    collapsedLayout,
    conversationPanelRef,
    defaultLayout,
    scopeId,
    utilityPanelRef,
    workspaceGroupRef,
  ])

  useEffect(() => {
    previousActiveSessionIdRef.current = activeSessionId
    knownSessionIdsRef.current = new Set(sessionIds)
  }, [activeSessionId, sessionIds])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const utilitySize = utilityPanelRef.current?.getSize()
      if (!utilitySize) return
      setOpen((current) => {
        const nextOpen = utilitySize.inPixels > 1
        return current === nextOpen ? current : nextOpen
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [utilityPanelRef])

  const restore = useCallback((): void => {
    if (window.innerWidth < 1180) onCollapseSidebar()
    const group = workspaceGroupRef.current
    const panel = utilityPanelRef.current
    const nextLayout = lastOpenLayoutRef.current ?? defaultLayout
    runAnimatedLayoutChange(() => {
      if (panel?.isCollapsed()) {
        panel.expand()
        group?.setLayout(nextLayout)
      }
    })
    persistActiveView({ open: true })
    setOpen(true)
  }, [
    defaultLayout,
    onCollapseSidebar,
    persistActiveView,
    runAnimatedLayoutChange,
    utilityPanelRef,
    workspaceGroupRef,
  ])

  const collapse = useCallback((): void => {
    const currentLayout = workspaceGroupRef.current?.getLayout()
    if (isOpenLayout(currentLayout)) {
      lastOpenLayoutRef.current = currentLayout
      setLayout(currentLayout)
      persistActiveView({ layout: currentLayout })
    }
    previousLayoutRef.current = null
    persistActiveView({ open: false, maximized: false })
    setMaximized(false)
    setOpen(false)
    runAnimatedLayoutChange(() => {
      utilityPanelRef.current?.collapse()
    })
  }, [persistActiveView, runAnimatedLayoutChange, utilityPanelRef, workspaceGroupRef])

  const toggle = useCallback((): void => {
    const panel = utilityPanelRef.current
    if (!panel) {
      setOpen((current) => {
        const nextOpen = !current
        persistActiveView({ open: nextOpen, maximized: false })
        return nextOpen
      })
      return
    }
    if (panel.isCollapsed()) restore()
    else collapse()
  }, [collapse, persistActiveView, restore, utilityPanelRef])

  const toggleMaximized = useCallback((): void => {
    setMaximized((current) => {
      if (current) {
        conversationPanelRef.current?.expand()
        persistActiveView({ maximized: false })
        return false
      }

      const currentLayout = workspaceGroupRef.current?.getLayout()
      if (currentLayout?.conversation && currentLayout.utility)
        previousLayoutRef.current = currentLayout
      if (utilityPanelRef.current?.isCollapsed()) utilityPanelRef.current.expand()
      conversationPanelRef.current?.collapse()
      persistActiveView({ open: true, maximized: true })
      setOpen(true)
      return true
    })
  }, [conversationPanelRef, persistActiveView, utilityPanelRef, workspaceGroupRef])

  const openFile = useCallback(
    (path: string, line?: number): void => {
      restore()
      setFileRequest({ id: Date.now(), scopeId: activeScopeIdRef.current, path, line })
    },
    [restore]
  )

  const openReview = useCallback(
    (path?: string): void => {
      restore()
      setReviewRequest({ id: Date.now(), scopeId: activeScopeIdRef.current, path })
    },
    [restore]
  )

  const openTerminal = useCallback(
    (terminalId: string): void => {
      restore()
      setTerminalRequest({ id: Date.now(), scopeId: activeScopeIdRef.current, terminalId })
    },
    [restore]
  )

  const openTool = useCallback(
    (tool: UtilityToolRequest): void => {
      restore()
      setToolRequest({ id: Date.now(), scopeId: activeScopeIdRef.current, tool })
    },
    [restore]
  )

  useEffect(() => {
    const group = workspaceGroupRef.current
    if (!group) return

    runAnimatedLayoutChange(() => {
      window.requestAnimationFrame(() => {
        if (maximized) {
          conversationPanelRef.current?.collapse()
          group.setLayout({ conversation: 0, utility: 100 })
          return
        }

        conversationPanelRef.current?.expand()
        const previousLayout = previousLayoutRef.current
        if (previousLayout) {
          group.setLayout(previousLayout)
          previousLayoutRef.current = null
        }
      })
    })
  }, [conversationPanelRef, maximized, runAnimatedLayoutChange, workspaceGroupRef])

  const handleLayoutChanged = useCallback(
    (nextLayout: Layout): void => {
      if (maximized || !isOpenLayout(nextLayout)) return
      lastOpenLayoutRef.current = nextLayout
      setLayout(nextLayout)
      persistActiveView({ layout: nextLayout })
    },
    [maximized, persistActiveView]
  )

  const handlePanelResize = useCallback((sizeInPixels: number): void => {
    const nextOpen = sizeInPixels > 1
    setOpen((current) => (current === nextOpen ? current : nextOpen))
  }, [])

  return {
    scopeId,
    instanceKey: `${scopeId}:${instanceRevision}`,
    open,
    maximized,
    visibleLayout: layout ?? defaultLayout,
    fileOpenRequest: fileRequest?.scopeId === scopeId ? fileRequest : null,
    terminalOpenRequest: terminalRequest?.scopeId === scopeId ? terminalRequest : null,
    toolOpenRequest: toolRequest?.scopeId === scopeId ? toolRequest : null,
    reviewOpenRequest: reviewRequest?.scopeId === scopeId ? reviewRequest : null,
    restore,
    collapse,
    toggle,
    toggleMaximized,
    openFile,
    openReview,
    openTerminal,
    openTool,
    handleLayoutChanged,
    handlePanelResize,
  }
}
