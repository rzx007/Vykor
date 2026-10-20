import type { SelectedLineRange, SelectionSide } from "@pierre/diffs"

export function readReviewTextSelection(root: ShadowRoot | HTMLElement): SelectedLineRange | null {
  const selection =
    (root as ShadowRoot & { getSelection?(): Selection | null }).getSelection?.() ??
    root.ownerDocument.getSelection()
  if (!selection?.rangeCount || !selection.toString()) return null
  let range: Pick<AbstractRange, "startContainer" | "endContainer"> = selection.getRangeAt(0)
  if (root instanceof ShadowRoot) {
    const composed = (
      selection as Selection & {
        getComposedRanges?(options: { shadowRoots: ShadowRoot[] }): StaticRange[]
      }
    ).getComposedRanges?.({ shadowRoots: [root] })
    if (composed?.[0]) range = composed[0]
  }
  const endpoint = (node: Node) => {
    if (!root.contains(node)) return null
    const element = node instanceof Element ? node : node.parentElement
    const line = element?.closest<HTMLElement>("[data-line]")
    if (!line) return null
    const number = Number(line.dataset.line)
    if (!Number.isInteger(number) || number < 1) return null
    const side: SelectionSide =
      line.closest("[data-deletions]") || line.dataset.lineType === "change-deletion"
        ? "deletions"
        : "additions"
    return { line: number, side }
  }
  const start = endpoint(range.startContainer),
    end = endpoint(range.endContainer)
  return start && end
    ? { start: start.line, end: end.line, side: start.side, endSide: end.side }
    : null
}

export function listenReviewTextSelection(
  node: HTMLElement,
  onSelection: (range: SelectedLineRange) => void
): () => void {
  let frame: number | null = null
  const read = (event: Event) => {
    if (
      event
        .composedPath()
        .some((target) => target instanceof Element && target.matches("button,input,textarea"))
    )
      return
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      const range = readReviewTextSelection(node.shadowRoot ?? node)
      if (range) onSelection(range)
    })
  }
  node.addEventListener("pointerup", read)
  node.addEventListener("keyup", read)
  return () => {
    node.removeEventListener("pointerup", read)
    node.removeEventListener("keyup", read)
    if (frame !== null) cancelAnimationFrame(frame)
  }
}
