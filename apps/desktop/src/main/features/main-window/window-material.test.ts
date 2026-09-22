// apps/desktop/src/main/features/main-window/window-material.test.ts
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"

import {
  applyMainWindowMaterial,
  mainWindowMaterialOptions,
  resolveWindowMaterialState,
  supportsNativeWindowMaterial,
  TRANSPARENT_WINDOW_BACKGROUND,
} from "./window-material"

describe("supportsNativeWindowMaterial", () => {
  it("只在 darwin / win32 / linux 上为真", () => {
    expect(supportsNativeWindowMaterial("darwin")).toBe(true)
    expect(supportsNativeWindowMaterial("win32")).toBe(true)
    expect(supportsNativeWindowMaterial("linux")).toBe(true)
    expect(supportsNativeWindowMaterial("freebsd")).toBe(false)
  })
})

describe("resolveWindowMaterialState", () => {
  it("用户选不透明时直接生效，且没有降级原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "opaque",
        reducedTransparency: true,
      })
    ).toEqual({
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })
  })

  it("macOS 玻璃生效时外壳半透明染色", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "translucent",
    })
  })

  it("Windows 玻璃生效时外壳全透明（材质只在内容透明处可见）", () => {
    expect(
      resolveWindowMaterialState({
        platform: "win32",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
  })

  it("Linux 玻璃生效时外壳同样是全透明", () => {
    expect(
      resolveWindowMaterialState({
        platform: "linux",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
  })

  it("系统开启降低透明度时降级为不透明并给出原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "glass",
        reducedTransparency: true,
      })
    ).toEqual({
      preference: "glass",
      active: "opaque",
      unavailableReason: "reduced-transparency",
      shell: "solid",
    })
  })

  it("平台不支持时降级为不透明并给出原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "freebsd",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "opaque",
      unavailableReason: "unsupported-platform",
      shell: "solid",
    })
  })
})

describe("mainWindowMaterialOptions", () => {
  const glass = {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    shell: "translucent",
  } as const
  const opaque = {
    preference: "opaque",
    active: "opaque",
    unavailableReason: null,
    shell: "solid",
  } as const
  const degradedGlass = {
    preference: "glass",
    active: "opaque",
    unavailableReason: "reduced-transparency",
    shell: "solid",
  } as const

  it("macOS 玻璃用 vibrancy 且不用 transparent", () => {
    expect(
      mainWindowMaterialOptions({ platform: "darwin", state: glass, useDarkColors: false })
    ).toEqual({
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      vibrancy: "under-window",
      visualEffectState: "active",
    })
  })

  it("macOS 不透明用主题底色且不带材质属性", () => {
    expect(
      mainWindowMaterialOptions({ platform: "darwin", state: opaque, useDarkColors: true })
    ).toEqual({ backgroundColor: "#20242a" })
  })

  it("Windows 玻璃用 acrylic 且不用 transparent", () => {
    expect(
      mainWindowMaterialOptions({ platform: "win32", state: glass, useDarkColors: false })
    ).toEqual({
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      backgroundMaterial: "acrylic",
    })
  })

  it("Windows 不透明用主题底色", () => {
    expect(
      mainWindowMaterialOptions({ platform: "win32", state: opaque, useDarkColors: false })
    ).toEqual({ backgroundColor: "#f4f7f9" })
  })

  it("Linux 无条件透明无阴影（运行期无法重建窗口，两档位都靠 renderer 铺底）", () => {
    const expected = {
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      transparent: true,
      hasShadow: false,
    }

    expect(
      mainWindowMaterialOptions({ platform: "linux", state: glass, useDarkColors: false })
    ).toEqual(expected)
    expect(
      mainWindowMaterialOptions({ platform: "linux", state: opaque, useDarkColors: true })
    ).toEqual(expected)
  })

  it("玻璃被系统降级时只用主题底色，不带任何材质属性", () => {
    expect(
      mainWindowMaterialOptions({
        platform: "darwin",
        state: degradedGlass,
        useDarkColors: false,
      })
    ).toEqual({ backgroundColor: "#f4f7f9" })
    expect(
      mainWindowMaterialOptions({ platform: "win32", state: degradedGlass, useDarkColors: true })
    ).toEqual({ backgroundColor: "#20242a" })
  })

  it("不支持的平台不走 Linux 分支，兜底返回主题底色", () => {
    expect(
      mainWindowMaterialOptions({ platform: "freebsd", state: opaque, useDarkColors: false })
    ).toEqual({ backgroundColor: "#f4f7f9" })
  })
})

describe("applyMainWindowMaterial", () => {
  const glass = {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    shell: "translucent",
  } as const
  const degradedGlass = {
    preference: "glass",
    active: "opaque",
    unavailableReason: "reduced-transparency",
    shell: "solid",
  } as const

  function createFakeWindow(isDestroyed = false) {
    return {
      isDestroyed: vi.fn(() => isDestroyed),
      setBackgroundColor: vi.fn(),
      setVibrancy: vi.fn(),
      setBackgroundMaterial: vi.fn(),
    }
  }

  it("macOS 玻璃：透明底 + under-window vibrancy", () => {
    const win = createFakeWindow()

    applyMainWindowMaterial(win as unknown as BrowserWindow, {
      platform: "darwin",
      state: glass,
      useDarkColors: false,
    })

    expect(win.setBackgroundColor).toHaveBeenCalledWith(TRANSPARENT_WINDOW_BACKGROUND)
    expect(win.setVibrancy).toHaveBeenCalledWith("under-window")
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it("macOS 降级：主题底色 + 清空 vibrancy", () => {
    const win = createFakeWindow()

    applyMainWindowMaterial(win as unknown as BrowserWindow, {
      platform: "darwin",
      state: degradedGlass,
      useDarkColors: true,
    })

    expect(win.setBackgroundColor).toHaveBeenCalledWith("#20242a")
    expect(win.setVibrancy).toHaveBeenCalledWith(null)
  })

  it("Windows 玻璃：透明底 + acrylic；降级：主题底色 + none", () => {
    const glassWin = createFakeWindow()

    applyMainWindowMaterial(glassWin as unknown as BrowserWindow, {
      platform: "win32",
      state: glass,
      useDarkColors: false,
    })

    expect(glassWin.setBackgroundColor).toHaveBeenCalledWith(TRANSPARENT_WINDOW_BACKGROUND)
    expect(glassWin.setBackgroundMaterial).toHaveBeenCalledWith("acrylic")
    expect(glassWin.setVibrancy).not.toHaveBeenCalled()

    const degradedWin = createFakeWindow()

    applyMainWindowMaterial(degradedWin as unknown as BrowserWindow, {
      platform: "win32",
      state: degradedGlass,
      useDarkColors: false,
    })

    expect(degradedWin.setBackgroundColor).toHaveBeenCalledWith("#f4f7f9")
    expect(degradedWin.setBackgroundMaterial).toHaveBeenCalledWith("none")
  })

  it("Linux：不碰底色、vibrancy 与材质，观感交给 renderer", () => {
    const win = createFakeWindow()

    applyMainWindowMaterial(win as unknown as BrowserWindow, {
      platform: "linux",
      state: glass,
      useDarkColors: false,
    })

    expect(win.setBackgroundColor).not.toHaveBeenCalled()
    expect(win.setVibrancy).not.toHaveBeenCalled()
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it("窗口已销毁时任何 setter 都不调用", () => {
    const win = createFakeWindow(true)

    applyMainWindowMaterial(win as unknown as BrowserWindow, {
      platform: "darwin",
      state: glass,
      useDarkColors: false,
    })

    expect(win.setBackgroundColor).not.toHaveBeenCalled()
    expect(win.setVibrancy).not.toHaveBeenCalled()
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })
})
