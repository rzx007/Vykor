import { afterEach, describe, expect, it, vi } from "vitest"

type Effect = () => void | (() => void)

const hookRuntime = vi.hoisted(() => {
  let cursor = 0
  const states: unknown[] = []
  const refs: { current: unknown }[] = []
  const effects: Array<{ effect: Effect; cleanup?: () => void }> = []

  return {
    useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
      const index = cursor++
      if (!(index in states)) {
        states[index] = typeof initial === "function" ? (initial as () => T)() : initial
      }
      return [
        states[index] as T,
        (value) => {
          states[index] =
            typeof value === "function" ? (value as (current: T) => T)(states[index] as T) : value
        },
      ]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index] as { current: T }
    },
    useEffect(effect: Effect): void {
      const index = cursor++
      if (!effects[index]) effects[index] = { effect }
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      cursor++
      return callback
    },
    render<T>(hook: () => T): T {
      cursor = 0
      return hook()
    },
    flushEffects(): void {
      for (const entry of effects) {
        if (entry && !entry.cleanup) entry.cleanup = entry.effect() ?? undefined
      }
    },
    reset(): void {
      for (const entry of effects) entry?.cleanup?.()
      cursor = 0
      states.length = 0
      refs.length = 0
      effects.length = 0
    },
    stateCount(): number {
      return states.length
    },
  }
})

vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react")
  return {
    ...react,
    useState: hookRuntime.useState,
    useRef: hookRuntime.useRef,
    useEffect: hookRuntime.useEffect,
    useCallback: hookRuntime.useCallback,
  }
})

import { useDesktopWindowChrome } from "../use-desktop-window-chrome"

type WindowChrome = ReturnType<typeof useDesktopWindowChrome>

type DesktopWindowFixture = {
  desktopWindow: {
    isMaximized: ReturnType<typeof vi.fn>
    getZoomLevel: ReturnType<typeof vi.fn>
    setZoomLevel: ReturnType<typeof vi.fn>
    onMaximizedChanged: ReturnType<typeof vi.fn>
    minimize: ReturnType<typeof vi.fn>
    toggleMaximize: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  emitMaximized: (value: boolean) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function createDesktopWindow(): DesktopWindowFixture {
  let maximizedListener: ((value: boolean) => void) | undefined
  const unsubscribe = vi.fn()
  const desktopWindow = {
    isMaximized: vi.fn(() => Promise.resolve(false)),
    getZoomLevel: vi.fn(() => Promise.resolve(0)),
    setZoomLevel: vi.fn((level: number) => Promise.resolve(level)),
    onMaximizedChanged: vi.fn((listener: (value: boolean) => void) => {
      maximizedListener = listener
      return unsubscribe
    }),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  }

  Object.assign(globalThis, { window: { desktop: { window: desktopWindow } } })

  return {
    desktopWindow,
    emitMaximized(value: boolean): void {
      maximizedListener?.(value)
    },
    unsubscribe,
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function renderChrome(): Promise<WindowChrome> {
  hookRuntime.render(useDesktopWindowChrome)
  hookRuntime.flushEffects()
  await Promise.resolve()
  return hookRuntime.render(useDesktopWindowChrome)
}

afterEach(() => {
  hookRuntime.reset()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, "window")
})

describe("useDesktopWindowChrome", () => {
  it("reads the initial maximized state and normalizes the initial zoom level", async () => {
    const { desktopWindow } = createDesktopWindow()
    desktopWindow.isMaximized.mockResolvedValue(true)
    desktopWindow.getZoomLevel.mockResolvedValue(2.6)

    const chrome = await renderChrome()

    expect(desktopWindow.isMaximized).toHaveBeenCalledOnce()
    expect(desktopWindow.getZoomLevel).toHaveBeenCalledOnce()
    expect(chrome.isMaximized).toBe(true)
    expect(chrome.zoomLevel).toBe(3)
  })

  it("updates from maximize events and unsubscribes when unmounted", async () => {
    const desktop = createDesktopWindow()
    await renderChrome()

    desktop.emitMaximized(true)
    const chrome = hookRuntime.render(useDesktopWindowChrome)

    expect(chrome.isMaximized).toBe(true)
    hookRuntime.reset()
    expect(desktop.unsubscribe).toHaveBeenCalledOnce()
  })

  it("does not let a stale initial maximize read overwrite a newer event", async () => {
    const desktop = createDesktopWindow()
    const initialMaximized = createDeferred<boolean>()
    desktop.desktopWindow.isMaximized.mockReturnValue(initialMaximized.promise)

    await renderChrome()
    desktop.emitMaximized(true)
    initialMaximized.resolve(false)
    await Promise.resolve()

    expect(hookRuntime.render(useDesktopWindowChrome).isMaximized).toBe(true)
  })

  it("normalizes requested and applied zoom levels", async () => {
    const { desktopWindow } = createDesktopWindow()
    desktopWindow.setZoomLevel.mockResolvedValue(-7)
    const chrome = await renderChrome()

    chrome.zoomOut()
    expect(desktopWindow.setZoomLevel).toHaveBeenCalledWith(-1)

    await Promise.resolve()
    const updatedChrome = hookRuntime.render(useDesktopWindowChrome)
    expect(updatedChrome.zoomLevel).toBe(-4)
  })

  it("keeps only the latest out-of-order zoom response and its level for the next request", async () => {
    const { desktopWindow } = createDesktopWindow()
    const firstResponse = createDeferred<number>()
    const secondResponse = createDeferred<number>()
    desktopWindow.setZoomLevel
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    const chrome = await renderChrome()

    chrome.zoomIn()
    chrome.zoomOut()
    expect(desktopWindow.setZoomLevel).toHaveBeenNthCalledWith(1, 1)
    expect(desktopWindow.setZoomLevel).toHaveBeenNthCalledWith(2, 0)

    secondResponse.resolve(-4)
    await Promise.resolve()
    firstResponse.resolve(6)
    await Promise.resolve()

    const updatedChrome = hookRuntime.render(useDesktopWindowChrome)
    expect(updatedChrome.zoomLevel).toBe(-4)
    updatedChrome.zoomIn()
    expect(desktopWindow.setZoomLevel).toHaveBeenNthCalledWith(3, -3)
  })

  it("does not write deferred initial or zoom results after unmount", async () => {
    const { desktopWindow } = createDesktopWindow()
    const maximized = createDeferred<boolean>()
    const initialZoom = createDeferred<number>()
    const appliedZoom = createDeferred<number>()
    desktopWindow.isMaximized.mockReturnValue(maximized.promise)
    desktopWindow.getZoomLevel.mockReturnValue(initialZoom.promise)
    desktopWindow.setZoomLevel.mockReturnValue(appliedZoom.promise)
    const chrome = await renderChrome()

    chrome.zoomIn()
    hookRuntime.reset()
    maximized.resolve(true)
    initialZoom.resolve(4)
    appliedZoom.resolve(5)
    await Promise.resolve()

    expect(hookRuntime.stateCount()).toBe(0)
  })

  it("swallows rejected IPC promises without an unhandled rejection", async () => {
    const { desktopWindow } = createDesktopWindow()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    desktopWindow.isMaximized.mockRejectedValue(new Error("maximized failed"))
    desktopWindow.getZoomLevel.mockRejectedValue(new Error("zoom read failed"))
    desktopWindow.setZoomLevel.mockRejectedValue(new Error("zoom write failed"))
    desktopWindow.minimize.mockRejectedValue(new Error("minimize failed"))
    desktopWindow.toggleMaximize.mockRejectedValue(new Error("toggle failed"))
    desktopWindow.close.mockRejectedValue(new Error("close failed"))

    const chrome = await renderChrome()
    chrome.zoomIn()
    chrome.minimize()
    chrome.toggleMaximize()
    chrome.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    process.off("unhandledRejection", onUnhandled)

    expect(unhandled).toEqual([])
  })

  it("forwards window controls to the desktop bridge", async () => {
    const { desktopWindow } = createDesktopWindow()
    const chrome = await renderChrome()

    chrome.minimize()
    chrome.toggleMaximize()
    chrome.close()

    expect(desktopWindow.minimize).toHaveBeenCalledOnce()
    expect(desktopWindow.toggleMaximize).toHaveBeenCalledOnce()
    expect(desktopWindow.close).toHaveBeenCalledOnce()
  })
})
