// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  STARTUP_OVERLAY_REMOVE_DELAY_MS,
  markStartupOverlayReady,
  watchStartupOverlay,
} from "../startup-overlay"

function mountDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="root"><main>Workspace</main></div>
    <div id="startup-loading"><svg aria-hidden="true"></svg></div>
  `
  return document.getElementById("startup-loading")!
}

describe("watchStartupOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ""
  })
  afterEach(() => vi.useRealTimers())

  it("主界面就绪后立即淡出，无需等待加载动画事件", () => {
    const overlay = mountDom()
    watchStartupOverlay()

    markStartupOverlayReady()

    expect(overlay.dataset.startupDismissed).toBe("true")
    expect(document.getElementById("startup-loading")).toBe(overlay)
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS - 1)
    expect(document.getElementById("startup-loading")).toBe(overlay)
    vi.advanceTimersByTime(1)
    expect(document.getElementById("startup-loading")).toBeNull()
    expect(document.querySelector("#root main")?.textContent).toBe("Workspace")
  })

  it("主界面未就绪时，动画结束和长时间等待都不会提前卸载", () => {
    const overlay = mountDom()
    watchStartupOverlay()

    overlay.querySelector("svg")!.dispatchEvent(new Event("animationend", { bubbles: true }))
    vi.advanceTimersByTime(30_000)

    expect(overlay.dataset.startupDismissed).toBeUndefined()
    expect(document.getElementById("startup-loading")).toBe(overlay)
  })

  it("就绪信号早于监听器注册时仍立即淡出", () => {
    const overlay = mountDom()
    markStartupOverlayReady()

    watchStartupOverlay()

    expect(overlay.dataset.startupDismissed).toBe("true")
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS)
    expect(document.getElementById("startup-loading")).toBeNull()
  })

  it("重复就绪信号不会延后移除时间", () => {
    mountDom()
    watchStartupOverlay()
    markStartupOverlayReady()
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS - 1)

    markStartupOverlayReady()
    vi.advanceTimersByTime(1)

    expect(document.getElementById("startup-loading")).toBeNull()
  })

  it("中断监听后不再响应就绪信号", () => {
    const overlay = mountDom()
    const stop = watchStartupOverlay()

    stop()
    markStartupOverlayReady()
    vi.advanceTimersByTime(30_000)

    expect(overlay.dataset.startupDismissed).toBeUndefined()
    expect(document.getElementById("startup-loading")).toBe(overlay)
  })

  it("淡出期间中断会清理移除定时器", () => {
    const overlay = mountDom()
    const stop = watchStartupOverlay()
    markStartupOverlayReady()

    stop()
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS)

    expect(document.getElementById("startup-loading")).toBe(overlay)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("启动遮罩已移除时安全返回", () => {
    document.body.innerHTML = '<div id="root"></div>'

    expect(() => watchStartupOverlay()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
