export const STARTUP_OVERLAY_ELEMENT_ID = "startup-loading"
const STARTUP_OVERLAY_READY_EVENT = "vykor:startup-ready"
/** 淡出结束后再 remove（比 CSS 里 #startup-loading 的 0.16s 过渡宽裕）。 */
export const STARTUP_OVERLAY_REMOVE_DELAY_MS = 200

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
 * 根页面提交后通过 markStartupOverlayReady() 通知淡出；加载动画不参与就绪判断，
 * 循环扫光或减少动态效果都不会延长等待。淡出后才真正移除遮罩。
 *
 * 返回值只在测试/中断场景使用，`main.tsx` 丢弃它。
 */
export function watchStartupOverlay(
  doc: Document = document,
  clock: StartupOverlayClock = defaultClock
): () => void {
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return () => {}

  let dismissed = false
  let removeTimer: Timer | undefined

  const dismiss = (): void => {
    if (dismissed) return
    dismissed = true
    overlay.removeEventListener(STARTUP_OVERLAY_READY_EVENT, dismiss)
    overlay.dataset.startupDismissed = "true"
    removeTimer = clock.setTimeout(() => overlay.remove(), STARTUP_OVERLAY_REMOVE_DELAY_MS)
  }

  overlay.addEventListener(STARTUP_OVERLAY_READY_EVENT, dismiss)
  if (overlay.dataset.startupReady === "true") dismiss()

  return () => {
    overlay.removeEventListener(STARTUP_OVERLAY_READY_EVENT, dismiss)
    if (removeTimer !== undefined) clock.clearTimeout(removeTimer)
  }
}

/** 页面提交后发出就绪信号；可早于 watchStartupOverlay() 调用。 */
export function markStartupOverlayReady(doc: Document | undefined = globalThis.document): void {
  if (!doc) return
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return
  overlay.dataset.startupReady = "true"
  overlay.dispatchEvent(new Event(STARTUP_OVERLAY_READY_EVENT))
}
