export const NOTE_DRAG_DISTANCE = 6
export const NOTE_MERGE_HOVER_MS = 250
export const FOLDER_OPEN_HOVER_MS = 400
export const FOLDER_EXIT_DISTANCE = 24

export type NoteDragTarget = { type: "note" | "folder"; id: string }
export type NoteDragIntent =
  | { type: "sort" }
  | { type: "hover-note" | "merge"; noteId: string }
  | { type: "hover-folder" | "open-folder"; folderId: string }

export function exceedsDragDistance(
  start: { x: number; y: number },
  end: { x: number; y: number }
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= NOTE_DRAG_DISTANCE
}

export function outsideFolder(
  point: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number }
): boolean {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
  return Math.hypot(dx, dy) >= FOLDER_EXIT_DISTANCE
}

/** 唯一的悬停目标、截止时间和意图来源；组件只安排计时器并检查 DOM 命中。 */
export function createNoteDragMachine() {
  let target: NoteDragTarget | null = null
  let deadline = 0
  let keyboard = false
  let intent: NoteDragIntent = { type: "sort" }
  const reset = (): void => {
    target = null
    deadline = 0
    intent = { type: "sort" }
  }
  const tick = (now: number): { intent: NoteDragIntent } => {
    if (!target) intent = { type: "sort" }
    else if (target.type === "folder")
      intent = {
        type: keyboard || now >= deadline ? "open-folder" : "hover-folder",
        folderId: target.id,
      }
    else if (!keyboard)
      intent = { type: now >= deadline ? "merge" : "hover-note", noteId: target.id }
    return { intent }
  }
  return {
    get intent() {
      return intent
    },
    start(input: { keyboard?: boolean } = {}) {
      reset()
      keyboard = Boolean(input.keyboard)
    },
    enter(next: NoteDragTarget | null, now: number) {
      const changed = next?.id !== target?.id || next?.type !== target?.type
      if (changed) {
        target = next
        deadline = now + (next?.type === "note" ? NOTE_MERGE_HOVER_MS : FOLDER_OPEN_HOVER_MS)
        intent = { type: "sort" }
      }
      return {
        ...tick(now),
        changed,
        delay: target && !keyboard ? Math.max(0, deadline - now) : null,
      }
    },
    merge(noteId: string): boolean {
      if (!keyboard || target?.type !== "note" || target.id !== noteId) return false
      intent = { type: "merge", noteId }
      return true
    },
    tick,
    reset,
    cancel: reset,
    scroll: reset,
  }
}
