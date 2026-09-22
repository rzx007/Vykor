import { describe, expect, it } from "vitest"

import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  isDesktopWindowMaterialPreference,
  parseWindowMaterialArguments,
  windowMaterialArguments,
  type DesktopWindowMaterialState,
} from "./window-material-types"

describe("isDesktopWindowMaterialPreference", () => {
  it("只接受 glass 与 opaque", () => {
    expect(isDesktopWindowMaterialPreference("glass")).toBe(true)
    expect(isDesktopWindowMaterialPreference("opaque")).toBe(true)
    expect(isDesktopWindowMaterialPreference("acrylic")).toBe(false)
    expect(isDesktopWindowMaterialPreference(undefined)).toBe(false)
  })
})

describe("windowMaterialArguments", () => {
  it("往返后得到同一个状态", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "opaque",
      unavailableReason: "reduced-transparency",
      shell: "solid",
    }

    expect(parseWindowMaterialArguments(windowMaterialArguments(state))).toEqual(state)
  })

  it("默认偏好是玻璃", () => {
    expect(DEFAULT_WINDOW_MATERIAL_PREFERENCE).toBe("glass")
  })

  it("缺参数、脏参数、未知取值都返回 null（宠物窗口走这条路径）", () => {
    expect(parseWindowMaterialArguments(["--no-sandbox"])).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=glass",
        "--openharness-window-material-active=holographic",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=transparent",
      ])
    ).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=mirror",
        "--openharness-window-material-active=glass",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=translucent",
      ])
    ).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=glass",
        "--openharness-window-material-active=glass",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=holographic",
      ])
    ).toBeNull()
  })
})
