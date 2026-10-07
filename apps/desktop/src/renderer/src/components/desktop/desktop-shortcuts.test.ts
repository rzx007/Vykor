// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { matchKeybindingPress, parseKeybinding } from "tinykeys"

import {
  desktopShortcuts,
  getShortcut,
  setShortcutBinding,
  clearShortcutBinding,
  resetShortcutBinding,
  resetAllShortcutBindings,
  shortcutLabel,
} from "./desktop-shortcuts"

afterEach(() => { vi.restoreAllMocks(); resetAllShortcutBindings() })

describe("desktop shortcuts", () => {
  it("reloads another window's overrides before checking collisions and preserves them during saves", () => {
    localStorage.setItem("vykor.desktop.shortcut-overrides-v1", JSON.stringify({ toggleSidebar: { binding: "$mod+Shift+KeyL", keys: "Shift+L" } }))
    expect(setShortcutBinding("togglePanel", "$mod+Shift+KeyL", "Shift+L")).toBe("conflict")
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+Shift+KeyL"])
    expect(setShortcutBinding("togglePanel", "$mod+Shift+KeyP", "Shift+P")).toBe("updated")
    expect(JSON.parse(localStorage.getItem("vykor.desktop.shortcut-overrides-v1")!)).toMatchObject({ toggleSidebar: { binding: "$mod+Shift+KeyL" }, togglePanel: { binding: "$mod+Shift+KeyP" } })
  })
  it("clears the actual binding and restores inheritance rather than saving a copied default", () => {
    expect(clearShortcutBinding("toggleSidebar")).toBe("updated")
    expect(getShortcut("toggleSidebar").bindings).toEqual([])
    expect(shortcutLabel("toggleSidebar")).toBe("未设置")
    expect(resetShortcutBinding("toggleSidebar")).toBe("updated")
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+b"])
    expect(localStorage.getItem("vykor.desktop.shortcut-overrides-v1")).toBeNull()
  })
  it("keeps last successful bindings if persistence fails and reserves normal editor combinations", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disk full") })
    expect(setShortcutBinding("toggleSidebar", "$mod+Shift+KeyL", "Shift+L")).toBe("storage_error")
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+b"])
    expect(setShortcutBinding("toggleSidebar", "$mod+KeyC", "C")).toBe("reserved")
  })
  it("uses valid tinykeys combinations for every command", () => {
    for (const shortcut of Object.values(desktopShortcuts)) {
      for (const binding of shortcut.bindings) {
        expect(() => parseKeybinding(binding)).not.toThrow()
      }
    }
  })

  it("formats the platform modifier for menus", () => {
    expect(shortcutLabel("zoomIn")).toBe("Ctrl+Shift+=")
    expect(shortcutLabel("zoomIn", true)).toBe("⌘+Shift+=")
  })

  it("matches the main keyboard and numpad zoom combinations", () => {
    expect(matches("$mod+Shift+Equal", "+", "Equal", ["Control", "Shift"])).toBe(true)
    expect(matches("$mod+Minus", "-", "Minus", ["Control"])).toBe(true)
    expect(matches("$mod+NumpadAdd", "+", "NumpadAdd", ["Control"])).toBe(true)
  })

  it("uses a saved replacement for both the keyboard handler and displayed label", () => {
    expect(setShortcutBinding("toggleSidebar", "$mod+Shift+KeyL", "Shift+L")).toBe("updated")
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+Shift+KeyL"])
    expect(shortcutLabel("toggleSidebar")).toBe("Ctrl+Shift+L")
    expect(shortcutLabel("toggleSidebar", true)).toBe("⌘+Shift+L")
    expect(setShortcutBinding("toggleSidebar", "$mod+b", "B")).toBe("updated")
  })

  it("rejects a binding already used by another command", () => {
    expect(setShortcutBinding("toggleSidebar", "$mod+KeyN", "N")).toBe("conflict")
    expect(getShortcut("toggleSidebar").bindings).toEqual(["$mod+b"])
  })
})

function matches(binding: string, key: string, code: string, modifiers: string[]): boolean {
  const event = {
    key,
    code,
    getModifierState: (modifier: string) => modifiers.includes(modifier),
  } as KeyboardEvent
  return matchKeybindingPress(event, parseKeybinding(binding)[0])
}
