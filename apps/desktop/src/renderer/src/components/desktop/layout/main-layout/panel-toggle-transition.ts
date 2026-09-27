const PANEL_ANIMATING_ATTRIBUTE = "data-panel-animating"
const PANEL_TOGGLE_TRANSITION_MS = 240

// One live transition per group element. A re-entrant begin cancels the previous
// one so its timer cannot strip the attribute part-way through the new animation.
const pendingCleanups = new WeakMap<HTMLElement, () => void>()

/**
 * Enables the panel-toggle transition on `groupElement` and returns a cancel function.
 *
 * The attribute that turns on the `transition` CSS property must be part of the
 * element's committed style BEFORE callers mutate `flex-grow`. If both changes land
 * in the same style update, some engines see no transition and the resize snaps.
 * Reading `offsetWidth` forces a synchronous style/layout recalc to flush the
 * attribute, so the subsequent `flex-grow` change animates.
 *
 * Calling this again for the same element replaces the previous pending transition;
 * the returned cancel is idempotent and a no-op when a newer transition superseded it.
 */
export function beginPanelToggleTransition(groupElement: HTMLElement | null): () => void {
  if (!groupElement) {
    return () => {}
  }

  const element = groupElement
  pendingCleanups.get(element)?.()

  element.setAttribute(PANEL_ANIMATING_ATTRIBUTE, "true")
  // Force a synchronous style/layout recalc so the transition property is part of
  // the element's committed style. Without this, the attribute and the flex-grow
  // change land in the same style change and the browser may not start a transition.
  void element.offsetWidth

  let timer: number | null = null

  const cancel = () => {
    if (pendingCleanups.get(element) !== cancel) {
      // A newer transition owns the element; leave its attribute alone.
      return
    }
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    pendingCleanups.delete(element)
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }

  timer = window.setTimeout(() => {
    timer = null
    if (pendingCleanups.get(element) === cancel) {
      pendingCleanups.delete(element)
    }
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }, PANEL_TOGGLE_TRANSITION_MS)

  pendingCleanups.set(element, cancel)
  return cancel
}
