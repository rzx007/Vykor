import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { DesktopWorkflowSnapshot } from "@shared/workflow-types"

type Selection = { runId?: string; taskId?: string; focus: number }
type WorkflowContextValue = {
  sessionId: string | null
  snapshot: DesktopWorkflowSnapshot | null
  loading: boolean
  error: string | null
  syncStatus: "connected" | "reconnecting"
  selection: Selection
  open(runId?: string, taskId?: string): void
  select(runId: string, taskId?: string, focus?: boolean): void
  refresh(): Promise<void>
  cancel(jobId: string): Promise<void>
}
const WorkflowContext = createContext<WorkflowContextValue | null>(null)
export const useWorkflows = () => useContext(WorkflowContext)

export function WorkflowProvider({
  sessionId,
  revision,
  syncStatus,
  onOpen,
  children,
}: {
  sessionId: string | null
  revision: number
  syncStatus: "connected" | "reconnecting"
  onOpen(): void
  children: ReactNode
}): React.JSX.Element {
  const [stored, setStored] = useState<DesktopWorkflowSnapshot | null>(null)
  const [failure, setFailure] = useState<{ sessionId: string; text: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<Selection & { sessionId: string | null }>({
    sessionId: null,
    focus: 0,
  })
  const selections = useRef(new Map<string, Selection>())
  const currentSession = useRef(sessionId)
  const request = useRef(0)
  const focusSequence = useRef(0)
  currentSession.current = sessionId
  const snapshot = stored?.sessionId === sessionId ? stored : null
  const selection =
    selected.sessionId === sessionId
      ? selected
      : (selections.current.get(sessionId ?? "") ?? { focus: 0 })

  const refresh = useCallback(async () => {
    if (!sessionId || currentSession.current !== sessionId || !window.desktop?.workflows) return
    const sequence = ++request.current
    setPending(true)
    try {
      const runId = selections.current.get(sessionId)?.runId
      const next = await window.desktop.workflows.read({
        sessionId,
        ...(runId ? { jobId: runId } : {}),
      })
      if (
        sequence !== request.current ||
        currentSession.current !== sessionId ||
        next.sessionId !== sessionId
      )
        return
      setStored(next)
      setFailure(null)
    } catch (error) {
      if (sequence === request.current && currentSession.current === sessionId)
        setFailure({ sessionId, text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (sequence === request.current && currentSession.current === sessionId) setPending(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || syncStatus !== "connected") return
    const timer = window.setTimeout(() => {
      void refresh()
    }, 80)
    return () => {
      window.clearTimeout(timer)
      request.current++
    }
  }, [sessionId, revision, syncStatus, refresh, selection.runId])

  // Events are the normal update path; a bounded safety read repairs missed final events.
  const active =
    snapshot?.runs.some((run) => run.status === "running" || run.status === "stopping") ?? false
  useEffect(() => {
    if (!active || syncStatus !== "connected") return
    const timer = window.setInterval(() => {
      if (!pending) void refresh()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [active, pending, refresh, syncStatus])

  const select = useCallback(
    (runId: string, taskId?: string, focus = false) => {
      const next = { runId, taskId, focus: focus ? ++focusSequence.current : 0 }
      if (sessionId) selections.current.set(sessionId, next)
      setSelected({ ...next, sessionId })
    },
    [sessionId]
  )
  const open = useCallback(
    (runId?: string, taskId?: string) => {
      if (runId) select(runId, taskId, true)
      onOpen()
    },
    [onOpen, select]
  )
  const cancel = useCallback(
    async (jobId: string) => {
      if (!sessionId) return
      const target = snapshot?.runs.find(run => run.jobId === jobId)?.target
      if (!target) throw new Error("请先选择当前编排。")
      await window.desktop.workflows.cancel({ sessionId, target })
      if (currentSession.current === sessionId) await refresh()
    },
    [sessionId, refresh, snapshot]
  )
  const value = useMemo(
    () => ({
      sessionId,
      snapshot,
      loading: pending || Boolean(sessionId && !snapshot && !failure),
      error: failure?.sessionId === sessionId ? failure.text : null,
      syncStatus,
      selection,
      select,
      open,
      refresh,
      cancel,
    }),
    [sessionId, snapshot, pending, failure, syncStatus, selection, select, open, refresh, cancel]
  )
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}
