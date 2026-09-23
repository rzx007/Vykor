// @vitest-environment jsdom
// apps/desktop/src/renderer/src/startup-overlay.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  STARTUP_OVERLAY_ANIMATION_FALLBACK_MS,
  STARTUP_OVERLAY_REACT_READY_FALLBACK_MS,
  STARTUP_OVERLAY_REMOVE_DELAY_MS,
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

  it("动画结束且 React 提交首帧后才淡出，再延迟移除", async () => {
    mountDom()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    commitReact()
    await Promise.resolve() // 等 MutationObserver 的微任务回调

    expect(getOverlay().dataset.startupDismissed).toBe("true")
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS)
    expect(document.getElementById("startup-loading")).toBeNull()
  })

  it("React 先就绪、动画随后结束时同样会卸载", async () => {
    mountDom()
    watchStartupOverlay()

    commitReact()
    await Promise.resolve()
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("动画事件缺失（reduced-motion）时由 1000ms 兜底", async () => {
    mountDom()
    watchStartupOverlay()
    commitReact()
    await Promise.resolve()

    vi.advanceTimersByTime(STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("React 始终不提交时由 3000ms 兜底", () => {
    mountDom()
    watchStartupOverlay()
    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))

    vi.advanceTimersByTime(STARTUP_OVERLAY_REACT_READY_FALLBACK_MS)
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("两个信号都没来时不会提前卸载", () => {
    mountDom()
    watchStartupOverlay()

    vi.advanceTimersByTime(STARTUP_OVERLAY_REACT_READY_FALLBACK_MS - 1)
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()
  })

  it("#root 在调用时已有子节点则视为已就绪", () => {
    mountDom()
    commitReact()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("#startup-loading 已被 dismissStartupLoading 移除时安全返回", () => {
    document.body.innerHTML = '<div id="root"></div>'

    expect(() => watchStartupOverlay()).not.toThrow()
  })
})
