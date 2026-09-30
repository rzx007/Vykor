import { describe, expect, it } from "vitest"
import { matchKeybindingPress, parseKeybinding } from "tinykeys"

import {
  desktopShortcuts,
  getShortcut,
  setShortcutBinding,
  shortcutLabel,
} from "./desktop-shortcuts"

describe("desktop shortcuts", () => {
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
