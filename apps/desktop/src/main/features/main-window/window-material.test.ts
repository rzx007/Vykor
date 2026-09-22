// apps/desktop/src/main/features/main-window/window-material.test.ts
import { describe, expect, it } from "vitest"

import {
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
    shell: "transparent",
  } as const
  const opaque = {
    preference: "opaque",
    active: "opaque",
    unavailableReason: null,
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
})
