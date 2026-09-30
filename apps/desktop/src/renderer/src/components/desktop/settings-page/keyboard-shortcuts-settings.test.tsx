// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getShortcut, setShortcutBinding } from "../desktop-shortcuts"
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings"

describe("KeyboardShortcutsSettings", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setShortcutBinding("toggleSidebar", "$mod+b", "B")
  })

  it("searches the existing commands without offering add or delete actions", () => {
    act(() => root.render(<KeyboardShortcutsSettings />))
    expect(container.textContent).toContain("新对话")
    expect(container.textContent).toContain("切换侧边栏")
    expect(container.querySelector('[aria-label="新增快捷键"]')).toBeNull()
    expect(container.querySelector('[aria-label="删除快捷键"]')).toBeNull()

    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索快捷键"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(search, "侧边栏")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.textContent).toContain("切换侧边栏")
    expect(container.textContent).not.toContain("新对话")
  })

  it("records a replacement for an existing command", () => {
    act(() => root.render(<KeyboardShortcutsSettings />))
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="修改切换侧边栏快捷键"]')!
    act(() => edit.click())
    const capture = container.querySelector<HTMLInputElement>(
      '[aria-label="录入切换侧边栏快捷键"]'
    )!
    act(() => {
      capture.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "L",
          code: "KeyL",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
      )
    })
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+Shift+KeyL"])
  })
})
