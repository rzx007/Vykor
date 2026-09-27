const PANEL_ANIMATING_ATTRIBUTE = "data-panel-animating"
const PANEL_TOGGLE_TRANSITION_MS = 240

export function beginPanelToggleTransition(groupElement: HTMLElement | null): () => void {
  if (!groupElement) {
    return () => {}
  }

  const element = groupElement
  element.setAttribute(PANEL_ANIMATING_ATTRIBUTE, "true")

  let timer: number | null = window.setTimeout(() => {
    timer = null
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }, PANEL_TOGGLE_TRANSITION_MS)

  return () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }
}
