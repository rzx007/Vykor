// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  applyStartupTheme,
  applyWindowMaterialToRoot,
  writeWindowMaterialAttributes,
} from "./apply-startup-theme"
import { APPEARANCE_STORAGE_KEY } from "./components/appearance/appearance-preferences"

function stubMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: prefersDark && query.includes("prefers-color-scheme: dark"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

describe("applyStartupTheme", () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove("light", "dark")
    vi.unstubAllGlobals()
  })

  it("applies a stored dark theme before React mounts", () => {
    stubMatchMedia(false)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "dark" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.classList.contains("light")).toBe(false)
  })

  it("applies a stored light theme even when the OS is dark", () => {
    stubMatchMedia(true)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "light" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("light")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("follows the OS preference when the stored theme is system", () => {
    stubMatchMedia(true)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "system" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})

function setSnapshot(snapshot: unknown): void {
  ;(window as unknown as { desktop?: unknown }).desktop = { window: { material: snapshot } }
}

describe("applyWindowMaterialToRoot", () => {
  afterEach(() => {
    delete (window as unknown as { desktop?: unknown }).desktop
  })

  it("macOS 玻璃写 glass/translucent", () => {
    setSnapshot({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "translucent",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("glass")
    expect(root.dataset.windowShell).toBe("translucent")
  })

  it("Windows / Linux 玻璃写 glass/transparent", () => {
    setSnapshot({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("glass")
    expect(root.dataset.windowShell).toBe("transparent")
  })

  it("不透明档写 opaque/solid", () => {
    setSnapshot({
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("opaque")
    expect(root.dataset.windowShell).toBe("solid")
  })

  it("快照缺失（宠物窗口）时不写任何属性", () => {
    setSnapshot(null)
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBeUndefined()
    expect(root.dataset.windowShell).toBeUndefined()
  })
})

describe("writeWindowMaterialAttributes", () => {
  it("不读快照，直接写给定状态（Provider 运行期切换用）", () => {
    setSnapshot(null)
    const root = document.createElement("html")

    writeWindowMaterialAttributes(root, {
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })

    expect(root.dataset.windowMaterial).toBe("opaque")
    expect(root.dataset.windowShell).toBe("solid")
  })
})
