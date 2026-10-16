import { useCallback, useState } from "react"

type TaskLocation = "default" | "current" | "worktree"

export function useTaskLocation(
  projectId: string | null
): [TaskLocation, (value: TaskLocation) => void] {
  const [choice, setChoice] = useState({ projectId, value: "default" as TaskLocation })
  // 在提交新项目的界面之前重置选择，避免 effect 再触发一次提交。
  if (choice.projectId !== projectId) setChoice({ projectId, value: "default" })
  const setLocation = useCallback(
    (value: TaskLocation) => setChoice({ projectId, value }),
    [projectId]
  )
  return [choice.projectId === projectId ? choice.value : "default", setLocation]
}
