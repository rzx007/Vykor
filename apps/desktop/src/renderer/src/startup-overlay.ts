export const STARTUP_OVERLAY_ELEMENT_ID = "startup-loading"
export const STARTUP_ROOT_ELEMENT_ID = "root"
/** 入场动画事件缺失（reduced-motion 把 animation 关掉）时的兜底。 */
export const STARTUP_OVERLAY_ANIMATION_FALLBACK_MS = 1000
/** React 始终不提交首帧（崩溃/白屏）时的兜底。 */
export const STARTUP_OVERLAY_REACT_READY_FALLBACK_MS = 3000
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
 * 启动遮罩卸载状态机。卸载条件 = 入场动画结束 ∧ React 已提交首帧。
 *
 * - 入场动画结束：`[data-startup-badge]` 的 animationend；reduced-motion 下 CSS 把 animation 关掉，
 *   事件永远不会来，由 STARTUP_OVERLAY_ANIMATION_FALLBACK_MS 兜底。
 * - React 已提交首帧：#root 出现第一个子节点（MutationObserver）；调用时已有子节点就直接视为就绪；
 *   始终没有出现时由 STARTUP_OVERLAY_REACT_READY_FALLBACK_MS 兜底。
 * 两个信号都满足后写 `data-startup-dismissed="true"` 触发 0.16s 淡出，再等 REMOVE_DELAY 后真正 remove()。
 *
 * `dismissStartupLoading()`（数据就绪/失败路径）会直接 remove 节点，是快速通道；
 * 节点已被移除时本函数立即返回，不报错。
 * 返回值只在测试/中断场景使用，`main.tsx` 丢弃它；注意若在 dismiss 之后再调用 cleanup，
 * 会把已排队的移除定时器清掉、节点留在 DOM 里（当前没有调用方这么做）。
 */
export function watchStartupOverlay(
  doc: Document = document,
  clock: StartupOverlayClock = defaultClock
): () => void {
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return () => {}

  const badge = overlay.querySelector("[data-startup-badge]")
  const reactRoot = doc.getElementById(STARTUP_ROOT_ELEMENT_ID)

  let animationSettled = false
  let reactSettled = reactRoot === null || reactRoot.childElementCount > 0
  let dismissed = false
  let observer: MutationObserver | null = null
  const timers = new Set<Timer>()

  const schedule = (handler: () => void, delay: number): void => {
    timers.add(clock.setTimeout(handler, delay))
  }

  const clearTimers = (): void => {
    for (const timer of timers) clock.clearTimeout(timer)
    timers.clear()
  }

  const dismiss = (): void => {
    if (dismissed || !animationSettled || !reactSettled) return
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

  if (badge) badge.addEventListener("animationend", onAnimationEnd)

  if (!reactSettled && reactRoot) {
    observer = new MutationObserver(() => {
      if (reactRoot.childElementCount === 0) return
      reactSettled = true
      observer?.disconnect()
      dismiss()
    })
    observer.observe(reactRoot, { childList: true })
  }

  schedule(() => {
    animationSettled = true
    dismiss()
  }, STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)

  schedule(() => {
    reactSettled = true
    observer?.disconnect()
    dismiss()
  }, STARTUP_OVERLAY_REACT_READY_FALLBACK_MS)

  return () => {
    observer?.disconnect()
    if (badge) badge.removeEventListener("animationend", onAnimationEnd)
    clearTimers()
  }
}
