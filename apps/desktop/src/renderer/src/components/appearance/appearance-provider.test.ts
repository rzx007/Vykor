// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAPI } from "@shared/desktop-api-contract"
import type { DesktopWindowMaterialState } from "@shared/window-material-types"

import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_PREFERENCES,
  type AppearancePreferences,
} from "./appearance-preferences"
import * as appearanceProviderModule from "./appearance-provider"
import {
  AppearanceProvider,
  type AppearanceContextValue,
  useAppearance,
} from "./appearance-provider"

type ControlledMediaQuery = MediaQueryList & {
  emit: (matches: boolean) => void
}

let latest: AppearanceContextValue | undefined

function Probe(): ReactElement {
  const appearance = useAppearance()
  useEffect(() => {
    latest = appearance
  }, [appearance])
  return createElement("output", {
    "data-theme": appearance.resolvedTheme,
    "data-motion": String(appearance.resolvedReducedMotion),
  })
}

function createMediaQuery(query: string, initialMatches: boolean): ControlledMediaQuery {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    media: query,
    get matches(): boolean {
      return matches
    },
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    }),
    dispatchEvent: vi.fn(() => true),
    emit(nextMatches: boolean): void {
      matches = nextMatches
      const event = { matches, media: query } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
  }

  return mediaQuery as ControlledMediaQuery
}

describe("AppearanceProvider", () => {
  let container: HTMLDivElement
  let root: Root
  let darkQuery: ControlledMediaQuery
  let reducedMotionQuery: ControlledMediaQuery

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-reduced-motion")
    document.documentElement.removeAttribute("style")
    darkQuery = createMediaQuery("(prefers-color-scheme: dark)", false)
    reducedMotionQuery = createMediaQuery("(prefers-reduced-motion: reduce)", false)
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        query === "(prefers-color-scheme: dark)" ? darkQuery : reducedMotionQuery
      )
    )
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    latest = undefined
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function renderProvider(): Promise<void> {
    await act(async () => {
      root.render(createElement(AppearanceProvider, null, createElement(Probe)))
    })
  }

  it("ignores the removed theme storage key", async () => {
    localStorage.setItem("openharness-desktop-theme", "dark")

    await renderProvider()

    expect(latest?.preferences).toEqual(DEFAULT_APPEARANCE_PREFERENCES)
    expect(latest?.resolvedTheme).toBe("light")
  })

  it("follows system theme changes", async () => {
    await renderProvider()
    expect(latest?.resolvedTheme).toBe("light")

    act(() => darkQuery.emit(true))

    expect(latest?.resolvedTheme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("resolves the three reduced-motion modes", async () => {
    reducedMotionQuery.emit(true)
    await renderProvider()
    expect(latest?.resolvedReducedMotion).toBe(true)

    act(() => latest?.setPreference("reducedMotion", "off"))
    expect(latest?.resolvedReducedMotion).toBe(false)

    act(() => latest?.setPreference("reducedMotion", "on"))
    expect(latest?.resolvedReducedMotion).toBe(true)
  })

  it("applies theme, typography, motion, and every color token to the root", async () => {
    const preferences: AppearancePreferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      theme: "dark",
      accent: { kind: "custom", value: "#006AFF" },
      uiFont: "inter",
      codeFont: "geist-mono",
      uiFontSize: 16,
      codeFontSize: 15,
      reducedMotion: "on",
    }
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences))

    await renderProvider()

    const rootStyle = document.documentElement.style
    expect(document.documentElement.className).toBe("dark")
    expect(document.documentElement.dataset.reducedMotion).toBe("true")
    expect(rootStyle.getPropertyValue("--font-sans")).toContain("Inter Variable")
    expect(rootStyle.getPropertyValue("--font-mono")).toContain("Geist Mono Variable")
    expect(rootStyle.getPropertyValue("--ui-font-size")).toBe("16px")
    expect(rootStyle.getPropertyValue("--code-font-size")).toBe("15px")
    for (const property of [
      "--primary",
      "--primary-foreground",
      "--ring",
      "--accent",
      "--accent-foreground",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
      "--sidebar-accent",
      "--sidebar-accent-foreground",
      "--sidebar-selected",
      "--file-link",
    ]) {
      expect(rootStyle.getPropertyValue(property), property).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it("persists a valid update before publishing it", async () => {
    await renderProvider()
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    let accepted = false

    act(() => {
      accepted = latest?.setPreference("theme", "dark") ?? false
    })

    expect(accepted).toBe(true)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")).toMatchObject({
      version: 1,
      theme: "dark",
    })
    expect(latest?.preferences.theme).toBe("dark")
    expect(latest?.saveState.status).toBe("saved")
  })

  it("keeps the current preferences when persistence fails", async () => {
    await renderProvider()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disk full")
    })
    let accepted = true

    act(() => {
      accepted = latest?.setPreference("theme", "dark") ?? true
    })

    expect(accepted).toBe(false)
    expect(latest?.preferences.theme).toBe("system")
    expect(latest?.saveState).toEqual({
      status: "error",
      message: "无法保存外观设置",
    })
  })

  it("applies another window's new-key storage update", async () => {
    await renderProvider()
    const updated = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      theme: "dark" as const,
    }

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: APPEARANCE_STORAGE_KEY,
          newValue: JSON.stringify(updated),
        })
      )
    })

    expect(latest?.preferences.theme).toBe("dark")
    expect(latest?.resolvedTheme).toBe("dark")
  })

  it("removes media and storage listeners when unmounted", async () => {
    const removeWindowListener = vi.spyOn(window, "removeEventListener")
    await renderProvider()

    act(() => root.unmount())
    root = createRoot(container)

    expect(darkQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
    expect(reducedMotionQuery.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    )
    expect(removeWindowListener).toHaveBeenCalledWith("storage", expect.any(Function))
  })

  it("does not expose the removed useTheme compatibility hook", () => {
    expect("useTheme" in appearanceProviderModule).toBe(false)
  })

  describe("window material", () => {
    const GLASS_TRANSPARENT: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    }

    function stubDesktop(
      material: DesktopWindowMaterialState | null,
      setMaterial: DesktopAPI["window"]["setMaterial"],
      getMaterial: DesktopAPI["window"]["getMaterial"] = () =>
        new Promise<DesktopWindowMaterialState>(() => undefined)
    ): void {
      ;(window as unknown as { desktop?: unknown }).desktop = {
        window: { material, getMaterial, setMaterial },
      } as unknown as DesktopAPI
    }

    afterEach(() => {
      delete (window as unknown as { desktop?: unknown }).desktop
      document.documentElement.removeAttribute("data-window-material")
      document.documentElement.removeAttribute("data-window-shell")
    })

    it("writes the startup material snapshot to the root", async () => {
      stubDesktop(GLASS_TRANSPARENT, vi.fn())

      await renderProvider()

      expect(latest?.windowMaterial).toEqual(GLASS_TRANSPARENT)
      expect(document.documentElement.dataset.windowMaterial).toBe("glass")
      expect(document.documentElement.dataset.windowShell).toBe("transparent")
    })

    it("reconciles the material state with the main process once after mount", async () => {
      const authoritative: DesktopWindowMaterialState = {
        preference: "opaque",
        active: "opaque",
        unavailableReason: null,
        shell: "solid",
      }
      const getMaterial = vi.fn(() => Promise.resolve(authoritative))
      stubDesktop(GLASS_TRANSPARENT, vi.fn(), getMaterial)

      await renderProvider()
      await act(async () => undefined)

      expect(getMaterial).toHaveBeenCalledTimes(1)
      expect(latest?.windowMaterial).toEqual(authoritative)
      expect(document.documentElement.dataset.windowMaterial).toBe("opaque")
      expect(document.documentElement.dataset.windowShell).toBe("solid")

      await renderProvider()

      expect(getMaterial).toHaveBeenCalledTimes(1)
    })

    it("optimistically writes a material switch, then follows the main process result", async () => {
      let resolveMaterial: (state: DesktopWindowMaterialState) => void = () => undefined
      const setMaterial = vi.fn(
        () =>
          new Promise<DesktopWindowMaterialState>((resolve) => {
            resolveMaterial = resolve
          })
      )
      stubDesktop(GLASS_TRANSPARENT, setMaterial)
      await renderProvider()

      act(() => latest?.setWindowMaterial("opaque"))

      expect(setMaterial).toHaveBeenCalledWith("opaque")
      expect(latest?.windowMaterial).toEqual({ ...GLASS_TRANSPARENT, preference: "opaque" })
      expect(document.documentElement.dataset.windowMaterial).toBe("glass")
      expect(document.documentElement.dataset.windowShell).toBe("transparent")

      const authoritative: DesktopWindowMaterialState = {
        preference: "opaque",
        active: "opaque",
        unavailableReason: null,
        shell: "solid",
      }
      await act(async () => {
        resolveMaterial(authoritative)
      })

      expect(latest?.windowMaterial).toEqual(authoritative)
      expect(document.documentElement.dataset.windowMaterial).toBe("opaque")
      expect(document.documentElement.dataset.windowShell).toBe("solid")
    })

    it("rolls a failed material switch back and reports the error", async () => {
      const setMaterial = vi.fn(() => Promise.reject(new Error("material unavailable")))
      stubDesktop(GLASS_TRANSPARENT, setMaterial)
      await renderProvider()

      await act(async () => {
        latest?.setWindowMaterial("opaque")
      })

      expect(latest?.windowMaterial).toEqual(GLASS_TRANSPARENT)
      expect(document.documentElement.dataset.windowMaterial).toBe("glass")
      expect(document.documentElement.dataset.windowShell).toBe("transparent")
      expect(latest?.saveState).toEqual({
        status: "error",
        message: "无法切换窗口材质",
      })
    })
  })
})
