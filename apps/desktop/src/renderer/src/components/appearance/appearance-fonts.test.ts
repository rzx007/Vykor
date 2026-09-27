import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  type AppearancePreferences,
} from "./appearance-preferences"
import {
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  detectLocalFontAvailability,
  repairUnavailableFonts,
} from "./appearance-fonts"

describe("appearance font registry", () => {
  it("distinguishes bundled, generic system, and fixed local fonts", () => {
    expect(UI_FONT_OPTIONS).toEqual([
      expect.objectContaining({ id: "system", source: "system-generic" }),
      expect.objectContaining({ id: "inter", source: "bundled" }),
      expect.objectContaining({ id: "segoe-ui", source: "local" }),
    ])
    expect(CODE_FONT_OPTIONS).toEqual([
      expect.objectContaining({ id: "geist-mono", source: "bundled" }),
      expect.objectContaining({ id: "cascadia-code", source: "local" }),
      expect.objectContaining({ id: "cascadia-mono", source: "local" }),
      expect.objectContaining({ id: "consolas", source: "local" }),
    ])
  })

  it("checks only the fixed local candidates with quoted font families", async () => {
    const check = vi.fn((query: string) => query.includes("Cascadia Code"))

    const availability = await detectLocalFontAvailability(check)

    expect(availability).toEqual({
      "segoe-ui": false,
      "cascadia-code": true,
      "cascadia-mono": false,
      consolas: false,
    })
    expect(check.mock.calls.map(([query]) => query)).toEqual([
      '12px "Segoe UI Variable Text"',
      '12px "Cascadia Code"',
      '12px "Cascadia Mono"',
      '12px "Consolas"',
    ])
  })

  it("appends a deterministic CJK fallback to every font stack", () => {
    for (const option of [...UI_FONT_OPTIONS, ...CODE_FONT_OPTIONS]) {
      expect(option.family, option.id).toContain('"Microsoft YaHei UI"')
    }

    for (const option of UI_FONT_OPTIONS) {
      expect(option.family, option.id).toContain('"PingFang SC"')
      expect(option.family, option.id).toMatch(/sans-serif$/)
    }

    for (const option of CODE_FONT_OPTIONS) {
      expect(option.family, option.id).toMatch(/monospace$/)
    }
  })

  it("repairs an unavailable saved local font to its bundled fallback", () => {
    const preferences: AppearancePreferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      uiFont: "segoe-ui",
      codeFont: "cascadia-code",
    }

    expect(
      repairUnavailableFonts(preferences, {
        "segoe-ui": false,
        "cascadia-code": false,
      })
    ).toEqual({
      ...preferences,
      uiFont: "inter",
      codeFont: "geist-mono",
    })
  })

  it("never treats generic system or bundled fonts as unavailable", () => {
    const systemAndBundled: AppearancePreferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      uiFont: "system",
      codeFont: "geist-mono",
    }
    const bundled: AppearancePreferences = {
      ...systemAndBundled,
      uiFont: "inter",
    }

    expect(repairUnavailableFonts(systemAndBundled, {})).toBe(systemAndBundled)
    expect(
      repairUnavailableFonts(bundled, {
        "segoe-ui": false,
        "cascadia-code": false,
        "cascadia-mono": false,
        consolas: false,
      })
    ).toBe(bundled)
  })

  it("waits for an explicit unavailable result before repairing", () => {
    const preferences: AppearancePreferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      codeFont: "consolas",
    }

    expect(repairUnavailableFonts(preferences, {})).toBe(preferences)
    expect(repairUnavailableFonts(preferences, { consolas: true })).toBe(preferences)
  })
})
