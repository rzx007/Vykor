import { describe, expect, it } from "vitest"

import type { DesktopWindowMaterialState } from "@shared/window-material-types"

import { windowMaterialDescription } from "./window-material-copy"

describe("windowMaterialDescription", () => {
  it("没有快照时说明使用设备默认外观", () => {
    expect(windowMaterialDescription(null)).toBe("窗口背景使用当前设备默认外观。")
  })

  it("材质生效时说明使用系统原生材质", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    }

    expect(windowMaterialDescription(state)).toBe(
      "窗口背景使用系统原生材质，桌面内容会被系统模糊后透进来。"
    )
  })

  it("用户选择不透明档时说明使用不透明底色", () => {
    const state: DesktopWindowMaterialState = {
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    }

    expect(windowMaterialDescription(state)).toBe(
      "窗口背景使用不透明底色，与系统窗口主题保持一致。"
    )
  })

  it("系统降低透明度时说明回退原因", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "opaque",
      unavailableReason: "reduced-transparency",
      shell: "solid",
    }

    expect(windowMaterialDescription(state)).toBe(
      "系统已开启「降低透明度」，窗口背景已回退为不透明。"
    )
  })

  it("系统不支持原生材质时说明回退为不透明", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "opaque",
      unavailableReason: "unsupported-platform",
      shell: "solid",
    }

    expect(windowMaterialDescription(state)).toBe(
      "当前系统不提供原生窗口材质，窗口背景已回退为不透明。"
    )
  })
})
