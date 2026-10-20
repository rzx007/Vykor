// @vitest-environment jsdom

import { act, createElement, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopUpdateState } from "@shared/update-types"

type HookApi = typeof import("../use-desktop-update-state")

type ProbeSnapshot = {
  visible: boolean
  status: DesktopUpdateState["status"]
  dismiss: () => void
}

describe("useDesktopUpdateState", () => {
  let container: HTMLDivElement
  let root: Root
  let emitState: (state: DesktopUpdateState) => void
  let latest: ProbeSnapshot | undefined
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
    latest = undefined
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

  it("subscribes to download progress and keeps it visible", async () => {
    updates.getState.mockResolvedValue({
      status: "downloading",
      version: "1.0.3",
      percent: 90.4,
      transferred: 5_200_000,
      total: 5_800_000,
      bytesPerSecond: 1_000,
    })
    await mount()

    expect(latest?.visible).toBe(true)
    expect(latest?.status).toBe("downloading")
  })

  it("keeps an available version dismissed after remounting the hook", async () => {
    updates.getState.mockResolvedValue({ status: "available", version: "1.8.0" })
    await mount()
    expect(latest?.visible).toBe(true)

    await act(async () => latest?.dismiss())
    expect(latest?.visible).toBe(false)

    await remount()
    expect(latest?.visible).toBe(false)
    expect(latest?.status).toBe("available")
  })

  it("shows the capsule again when version or status changes after dismiss", async () => {
    updates.getState.mockResolvedValue({ status: "available", version: "1.8.0" })
    await mount()
    await act(async () => latest?.dismiss())
    expect(latest?.visible).toBe(false)

    await act(async () => emitState({ status: "available", version: "1.9.0" }))
    expect(latest?.visible).toBe(true)

    await act(async () => latest?.dismiss())
    await act(async () =>
      emitState({ status: "error", version: "1.9.0", message: "下载失败" })
    )
    expect(latest?.visible).toBe(true)
  })

  it("keeps downloading and downloaded states visible even after dismiss", async () => {
    updates.getState.mockResolvedValue({
      status: "downloading",
      version: "2.0.0",
      percent: 10,
      transferred: 1,
      total: 10,
      bytesPerSecond: 1,
    })
    await mount()
    await act(async () => latest?.dismiss())
    expect(latest?.visible).toBe(true)

    await act(async () => emitState({ status: "downloaded", version: "2.0.0" }))
    await act(async () => latest?.dismiss())
    expect(latest?.visible).toBe(true)
  })

  it("unsubscribes from update state changes when unmounted", async () => {
    await mount()
    await act(async () => root.unmount())
    expect(unsubscribe).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  async function mount(): Promise<void> {
    const hook = await loadHook()
    await act(async () => {
      root.render(createElement(Probe, { hook, onSnapshot: (snapshot) => (latest = snapshot) }))
    })
  }

  async function remount(): Promise<void> {
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount()
  }
})

async function loadHook(): Promise<HookApi> {
  return import("../use-desktop-update-state")
}

function Probe({
  hook,
  onSnapshot,
}: {
  hook: HookApi
  onSnapshot: (snapshot: ProbeSnapshot) => void
}): React.JSX.Element {
  const value = hook.useDesktopUpdateState()
  useEffect(() => {
    onSnapshot({
      visible: value.visible,
      status: value.state.status,
      dismiss: value.dismiss,
    })
  })
  return createElement("div")
}
