const PANEL_ANIMATING_ATTRIBUTE = "data-panel-animating"
const PANEL_TOGGLE_TRANSITION_MS = 240

/**
 * Enables the panel-toggle transition on `groupElement` and returns a cancel function.
 *
 * The attribute that turns on the `transition` CSS property must be part of the
 * element's committed style BEFORE callers mutate `flex-grow`. If both changes land
 * in the same style update, some engines see no transition and the resize snaps.
 * Reading `offsetWidth` forces a synchronous style/layout recalc to flush the
 * attribute, so the subsequent `flex-grow` change animates.
 */
export function beginPanelToggleTransition(groupElement: HTMLElement | null): () => void {
  if (!groupElement) {
    return () => {}
  }

  const element = groupElement
  element.setAttribute(PANEL_ANIMATING_ATTRIBUTE, "true")
  // Force a synchronous style/layout recalc so the transition property is part of
  // the element's committed style. Without this, the attribute and the flex-grow
  // change land in the same style change and the browser may not start a transition.
  void element.offsetWidth

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
