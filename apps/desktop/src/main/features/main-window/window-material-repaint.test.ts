import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MATERIAL_REPAINT_DELAY_MS, attachWindowsMaterialRepaint } from "./window-material-repaint"

type FakeWindow = Parameters<typeof attachWindowsMaterialRepaint>[0]

function createFakeWindow() {
  const listeners = new Map<string, () => void>()
  const invalidate = vi.fn()
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), invalidate },
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
      return win
    }),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
      return win
    }),
  }
  return { win, listeners, invalidate }
}

describe("attachWindowsMaterialRepaint", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("resized 后立即重绘一次，32ms 后再补一次", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    expect(invalidate).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it("show 复用同一个补偿函数", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("show")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it("连续事件只保留一个补帧定时器", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    listeners.get("resized")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it("窗口或 webContents 已销毁时不再重绘", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    win.isDestroyed.mockReturnValue(true)
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).not.toHaveBeenCalled()
  })
})
