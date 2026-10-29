// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import { ContextUsageControl } from "../context-usage-control"

const snapshot: DesktopContextUsageSnapshot = {
  model: "test-model",
  contextWindow: 100_000,
  estimatedInputTokens: 12_000,
  percentFull: 0.12,
  estimator: "heuristic_v1",
  buckets: [{ id: "conversation", label: "对话", tokens: 12_000 }],
  tips: [],
  computedAt: "2026-10-29T00:00:00.000Z",
  source: "session_cache",
}

function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("ContextUsageControl loading feedback", () => {
  let container: HTMLDivElement
  let root: Root | null

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function render(
    onOpen?: () => void | Promise<boolean | void>,
    value: DesktopContextUsageSnapshot | null = null
  ) {
    await act(async () => root!.render(<ContextUsageControl snapshot={value} onOpen={onOpen} />))
  }

  async function toggle() {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
  }

  function retryButton() {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试"
    )
  }

  it("exposes the popover expanded state on the ring button", async () => {
    await render()
    const trigger = container.querySelector<HTMLButtonElement>("button")!
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    await toggle()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
  })

  it("stops loading and offers a focusable retry when the first read fails", async () => {
    const request = deferred()
    await render(() => request.promise)
    await toggle()
    expect(document.body.textContent).toContain("正在加载上下文")

    await act(async () => request.resolve(false))
    expect(document.querySelector('[role="alert"]')?.textContent ?? "").toContain(
      "上下文用量读取失败"
    )
    expect(document.body.textContent).not.toContain("正在加载上下文")
    const retry = retryButton()!
    expect(retry.type).toBe("button")
    expect(retry.disabled).toBe(false)
    retry.focus()
    expect(document.activeElement).toBe(retry)
  })

  it("shows an empty state when there is no read entry point", async () => {
    await render()
    await toggle()
    expect(document.body.textContent).toContain("暂无上下文用量")
    expect(document.body.textContent).not.toContain("正在加载上下文")
    expect(retryButton()).toBeUndefined()
  })

  it.each(["sync", "async"])(
    "does not treat an undefined %s result as a failed read",
    async (kind) => {
      await render(kind === "sync" ? () => undefined : () => Promise.resolve())
      await toggle()
      expect(document.body.textContent).toContain("暂无上下文用量")
      expect(document.querySelector('[role="status"]')).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
    }
  )

  it("offers retry if the read entry point throws synchronously", async () => {
    await render(() => {
      throw new Error("读取失败")
    })
    await toggle()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("上下文用量读取失败")
    expect(retryButton()).toBeDefined()
  })

  it("clears a failed read after retry succeeds with a snapshot", async () => {
    const retry = deferred()
    const onOpen = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(retry.promise)
    await render(onOpen)
    await toggle()
    await act(async () => retryButton()!.click())
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toContain("正在加载上下文")

    await act(async () => {
      root!.render(<ContextUsageControl snapshot={snapshot} onOpen={onOpen} />)
      retry.resolve(true)
    })
    expect(document.body.textContent).toContain("12% 已用")
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(retryButton()).toBeUndefined()
  })

  it("keeps the previous snapshot visible when refreshing fails", async () => {
    const refresh = deferred()
    const onOpen = vi.fn().mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(true)
    await render(onOpen, snapshot)
    await toggle()
    expect(document.body.textContent).toContain("12% 已用")
    await act(async () => refresh.resolve(false))
    expect(document.body.textContent).toContain("12% 已用")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("更新失败")
    await act(async () => retryButton()!.click())
    expect(document.body.textContent).toContain("12% 已用")
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it("ignores a closed request while a reopened tray is still loading", async () => {
    const older = deferred()
    const current = deferred()
    const onOpen = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise)
    await render(onOpen)
    await toggle()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.querySelector('[data-slot="popover-content"][data-open]')).toBeNull()
    await toggle()
    await act(async () => older.resolve(false))
    expect(document.querySelector('[role="status"]')?.textContent).toContain("正在加载上下文")
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await act(async () => current.resolve(false))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("上下文用量读取失败")
  })

  it("does not let an earlier success clear the failure from reopening", async () => {
    const older = deferred()
    const current = deferred()
    const onOpen = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise)
    await render(onOpen)
    await toggle()
    await toggle()
    await toggle()
    await act(async () => current.resolve(false))
    await act(async () => older.resolve(true))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("上下文用量读取失败")
  })

  it("reports thrown errors and handles late rejection after unmount", async () => {
    const request = deferred()
    const onOpen = vi
      .fn()
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockReturnValueOnce(request.promise)
    await render(onOpen)
    await toggle()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("上下文用量读取失败")
    await act(async () => retryButton()!.click())
    await act(async () => {
      root!.unmount()
      root = null
      request.reject(new Error("迟到的读取失败"))
    })
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
