// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopUpdateState } from "@shared/update-types"

describe("UpdateStatusCapsule", () => {
  let container: HTMLDivElement
  let root: Root
  let emitState: (state: DesktopUpdateState) => void
  const unsubscribe = vi.fn()
  const updates = {
    getState: vi.fn<() => Promise<DesktopUpdateState>>(),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    onStateChanged: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      emitState = listener
      return unsubscribe
    }),
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    updates.getState.mockResolvedValue({ status: "idle" })
    Reflect.set(window, "desktop", { updates })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.resetModules()
    Reflect.deleteProperty(window, "desktop")
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("shows download progress without a dialog overlay", async () => {
    updates.getState.mockResolvedValue({
      status: "downloading",
      version: "1.0.3",
      percent: 90.4,
      transferred: 5_200_000,
      total: 5_800_000,
      bytesPerSecond: 1_000,
    })
    await mount()

    expect(container.textContent).toContain("下载中 90%")
    expect(container.querySelector("[data-slot='alert-dialog'], [data-slot='dialog']")).toBeNull()
    expect(findButton("关闭")).toBeNull()
    expect(container.querySelector("[data-update-capsule]")?.className).toContain("bg-primary")
    expect(container.querySelector("[data-update-capsule-spinner]")).not.toBeNull()
  })

  it("starts a download from the available capsule and can dismiss it", async () => {
    updates.getState.mockResolvedValue({ status: "available", version: "1.8.0" })
    await mount()

    expect(container.textContent).toContain("新版本 1.8.0")
    await click("新版本 1.8.0")
    expect(updates.download).toHaveBeenCalledOnce()

    await act(async () => emitState({ status: "available", version: "1.9.0" }))
    await click("关闭")
    expect(container.textContent).not.toContain("1.9.0")
  })

  it("installs a downloaded update from the capsule", async () => {
    updates.getState.mockResolvedValue({ status: "downloaded", version: "2.1.0" })
    await mount()

    await click("重启安装")
    expect(updates.install).toHaveBeenCalledOnce()
    expect(container.querySelector("[data-update-capsule]")?.className).toContain("bg-primary")
  })

  it("lets the user dismiss an update error", async () => {
    updates.getState.mockResolvedValue({
      status: "error",
      version: "2.1.0",
      message: "下载文件校验失败",
    })
    await mount()

    expect(container.textContent).toContain("更新失败")
    await click("关闭")
    expect(container.textContent).not.toContain("更新失败")
  })

  async function mount(): Promise<void> {
    const { UpdateStatusCapsule } = await import("../update-status-capsule")
    await act(async () => {
      root.render(createElement(UpdateStatusCapsule))
    })
  }

  async function click(label: string): Promise<void> {
    await act(async () => {
      findButton(label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }
})

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label
    ) ?? null
  )
}
