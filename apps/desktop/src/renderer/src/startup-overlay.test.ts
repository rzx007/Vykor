// @vitest-environment jsdom
// apps/desktop/src/renderer/src/startup-overlay.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  STARTUP_OVERLAY_ANIMATION_FALLBACK_MS,
  STARTUP_OVERLAY_REMOVE_DELAY_MS,
  markStartupOverlayReady,
  watchStartupOverlay,
} from "./startup-overlay"

function mountDom(): void {
  document.body.innerHTML = `
    <div id="root"></div>
    <div id="startup-loading"><div data-startup-badge="true"></div></div>
  `
}

function getOverlay(): HTMLElement {
  return document.getElementById("startup-loading")!
}

function commitReact(): void {
  document.getElementById("root")!.appendChild(document.createElement("div"))
}

describe("watchStartupOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ""
  })
  afterEach(() => vi.useRealTimers())

  it("bootstrap 未完成时不会因 React 首帧提交而淡出", async () => {
    mountDom()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    commitReact()
    await Promise.resolve()

    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    markStartupOverlayReady()
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("动画结束且 bootstrap 完成后才淡出，再延迟移除", () => {
    mountDom()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    markStartupOverlayReady()

    expect(getOverlay().dataset.startupDismissed).toBe("true")
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS)
    expect(document.getElementById("startup-loading")).toBeNull()
  })

  it("bootstrap 先完成、动画随后结束时同样会卸载", () => {
    mountDom()
    watchStartupOverlay()

    markStartupOverlayReady()
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("动画事件缺失（reduced-motion）时由 1000ms 兜底", () => {
    mountDom()
    watchStartupOverlay()
    markStartupOverlayReady()

    vi.advanceTimersByTime(STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("bootstrap 未完成时不会由定时器提前卸载", () => {
    mountDom()
    watchStartupOverlay()
    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))

    vi.advanceTimersByTime(30_000)
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()
  })

  it("两个信号都没来时不会提前卸载", () => {
    mountDom()
    watchStartupOverlay()

    vi.advanceTimersByTime(30_000)
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()
  })

  it("就绪信号早于监听器注册时仍会卸载", () => {
    mountDom()
    markStartupOverlayReady()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("#startup-loading 已被 dismissStartupLoading 移除时安全返回", () => {
    document.body.innerHTML = '<div id="root"></div>'

    expect(() => watchStartupOverlay()).not.toThrow()
  })
})
