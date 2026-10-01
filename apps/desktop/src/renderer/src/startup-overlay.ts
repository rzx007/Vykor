export const STARTUP_OVERLAY_ELEMENT_ID = "startup-loading"
const STARTUP_OVERLAY_READY_EVENT = "vykor:startup-ready"
/** 入场动画事件缺失（reduced-motion 把 animation 关掉）时的兜底。 */
export const STARTUP_OVERLAY_ANIMATION_FALLBACK_MS = 1000
/** 淡出结束后再 remove（比 CSS 里 #startup-loading 的 0.16s 过渡宽裕）。 */
export const STARTUP_OVERLAY_REMOVE_DELAY_MS = 500

type Timer = ReturnType<typeof setTimeout>

export interface StartupOverlayClock {
  setTimeout: (handler: () => void, delay: number) => Timer
  clearTimeout: (id: Timer) => void
}

const defaultClock: StartupOverlayClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}

/**
 * 启动遮罩卸载状态机。卸载条件 = 入场动画结束 ∧ 应用 bootstrap 已结束。
 *
 * - 入场动画结束：`[data-startup-badge]` 的 animationend；reduced-motion 下 CSS 把 animation 关掉，
 *   事件永远不会来，由 STARTUP_OVERLAY_ANIMATION_FALLBACK_MS 兜底。
 * - 应用已就绪：bootstrap 成功或失败后调用 markStartupOverlayReady()。
 * 两个信号都满足后写 `data-startup-dismissed="true"` 触发 0.16s 淡出，再等 REMOVE_DELAY 后真正 remove()。
 *
 * 返回值只在测试/中断场景使用，`main.tsx` 丢弃它。
 */
export function watchStartupOverlay(
  doc: Document = document,
  clock: StartupOverlayClock = defaultClock
): () => void {
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return () => {}

  const badge = overlay.querySelector("[data-startup-badge]")

  let animationSettled = false
  let applicationSettled = overlay.dataset.startupReady === "true"
  let dismissed = false
  const timers = new Set<Timer>()

  const schedule = (handler: () => void, delay: number): void => {
    timers.add(clock.setTimeout(handler, delay))
  }

  const clearTimers = (): void => {
    for (const timer of timers) clock.clearTimeout(timer)
    timers.clear()
  }

  const dismiss = (): void => {
    if (dismissed || !animationSettled || !applicationSettled) return
    dismissed = true
    clearTimers()
    overlay.dataset.startupDismissed = "true"
    // 注意：这行必须在 clearTimers() 之后，否则刚排的移除定时器会被自己清掉。
    schedule(() => overlay.remove(), STARTUP_OVERLAY_REMOVE_DELAY_MS)
  }

  const onAnimationEnd = (event: Event): void => {
    if (event.target !== badge) return
    animationSettled = true
    dismiss()
  }

  const onApplicationReady = (): void => {
    applicationSettled = true
    dismiss()
  }

  if (badge) badge.addEventListener("animationend", onAnimationEnd)
  overlay.addEventListener(STARTUP_OVERLAY_READY_EVENT, onApplicationReady)

  schedule(() => {
    animationSettled = true
    dismiss()
  }, STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)

  return () => {
    if (badge) badge.removeEventListener("animationend", onAnimationEnd)
    overlay.removeEventListener(STARTUP_OVERLAY_READY_EVENT, onApplicationReady)
    clearTimers()
  }
}

/** bootstrap 成功或失败后发出真实就绪信号；可早于 watchStartupOverlay() 调用。 */
export function markStartupOverlayReady(doc: Document | undefined = globalThis.document): void {
  if (!doc) return
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return
  overlay.dataset.startupReady = "true"
  overlay.dispatchEvent(new Event(STARTUP_OVERLAY_READY_EVENT))
}
