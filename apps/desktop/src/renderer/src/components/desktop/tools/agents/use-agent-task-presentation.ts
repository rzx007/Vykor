import { useEffect, useState } from "react"
import type { DesktopAgentActivity, DesktopSessionTask } from "@shared/session-types"
import { agentTaskPresentation } from "./agent-task-model"

/** Read the same live snapshot used by JobRead while this task is visible. */
export function useAgentTaskPresentation(task?: DesktopSessionTask) {
  const sessionId = task?.sessionId
  const jobId = task?.id
  const runId = task?.runId
  const running = task?.type === "agent" && task.status === "running" && Boolean(task.childSessionId)
  const key = JSON.stringify([sessionId, jobId, runId])
  const [now, setNow] = useState(() => Date.now())
  const [sample, setSample] = useState<{ key: string; activity: DesktopAgentActivity | null; at: number }>()

  useEffect(() => {
    if (!running || !sessionId || !jobId || !runId) return
    let active = true
    let pending = false
    const poll = async () => {
      setNow(Date.now())
      if (pending) return
      pending = true
      const startedAt = Date.now()
      try {
        const activity = await window.desktop.sessions.readAgentActivity({ sessionId, jobId, runId })
        if (active) {
          setNow(Date.now())
          setSample({ key, activity, at: startedAt })
        }
      } catch {
        if (active) setSample({ key, activity: null, at: Date.now() })
      } finally {
        pending = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [running, sessionId, jobId, runId, key])

  const activity = running && sample?.key === key && now - sample.at < 45_000 ? sample.activity : undefined
  return task ? agentTaskPresentation(task, now, activity) : undefined
}
