import { describe, expect, it } from "vitest"

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  normalizeHexColor,
  parseAppearancePreferences,
} from "./appearance-preferences"

describe("appearance preferences", () => {
  it("restores per-mode colors independently and normalizes valid values", () => {
    const parsed = parseAppearancePreferences(
      JSON.stringify({
        version: 1,
        theme: "system",
        colors: {
          light: { background: "#eff1f5", foreground: "broken" },
          dark: { background: "#282a36", foreground: "f8f8f2" },
        },
      })
    )
    expect(parsed).toMatchObject({
      colors: {
        light: { background: "#EFF1F5", foreground: null },
        dark: { background: "#282A36", foreground: "#F8F8F2" },
      },
    })
    expect(parseAppearancePreferences('{"version":1,"theme":"dark"}')).toMatchObject({
      theme: "dark",
      colors: {
        light: { background: null, foreground: null },
        dark: { background: null, foreground: null },
      },
    })
  })
  it("provides the product defaults", () => {
    expect(DEFAULT_APPEARANCE_PREFERENCES).toEqual({
      version: 1,
      theme: "system",
      accent: { kind: "preset", id: "neutral" },
      colors: {
        light: { background: null, foreground: null },
        dark: { background: null, foreground: null },
      },
      uiFont: "inter",
      codeFont: "geist-mono",
      uiFontSize: 14,
      codeFontSize: 14,
      reducedMotion: "system",
      glassStrength: 35,
    })
  })

  it("parses every supported preference from version 1 JSON", () => {
    expect(
      parseAppearancePreferences(
        JSON.stringify({
          version: 1,
          theme: "dark",
          accent: { kind: "custom", value: "#0a6aff" },
          uiFont: "inter",
          codeFont: "consolas",
          uiFontSize: 16,
          codeFontSize: 15,
          reducedMotion: "on",
        })
      )
    ).toEqual({
      version: 1,
      theme: "dark",
      accent: { kind: "custom", value: "#0A6AFF" },
      colors: {
        light: { background: null, foreground: null },
        dark: { background: null, foreground: null },
      },
      uiFont: "inter",
      codeFont: "consolas",
      uiFontSize: 16,
      codeFontSize: 15,
      reducedMotion: "on",
      glassStrength: 35,
    })
  })

  it("recovers invalid fields independently without discarding valid fields", () => {
    expect(
      parseAppearancePreferences(
        JSON.stringify({
          version: 1,
          theme: "dark",
          accent: { kind: "preset", id: "orange" },
          uiFont: "comic-sans",
          codeFont: "papyrus",
          uiFontSize: "16",
          codeFontSize: null,
          reducedMotion: "sometimes",
        })
      )
    ).toEqual({
      version: 1,
      theme: "dark",
      accent: { kind: "preset", id: "neutral" },
      colors: {
        light: { background: null, foreground: null },
        dark: { background: null, foreground: null },
      },
      uiFont: "inter",
      codeFont: "geist-mono",
      uiFontSize: 14,
      codeFontSize: 14,
      reducedMotion: "system",
      glassStrength: 35,
    })
  })

  it("rounds and clamps numeric font sizes", () => {
    expect(
      parseAppearancePreferences('{"version":1,"uiFontSize":99,"codeFontSize":10.6}')
    ).toMatchObject({ uiFontSize: 18, codeFontSize: 11 })

    expect(
      parseAppearancePreferences('{"version":1,"uiFontSize":12.6,"codeFontSize":17.5}')
    ).toMatchObject({ uiFontSize: 13, codeFontSize: 18 })
  })

  it("restores and bounds glass strength without discarding an older theme preference", () => {
    expect(
      parseAppearancePreferences('{"version":1,"theme":"dark","glassStrength":80}')
    ).toMatchObject({ theme: "dark", glassStrength: 80 })
    expect(parseAppearancePreferences('{"version":1,"theme":"dark"}')).toMatchObject({
      theme: "dark",
      glassStrength: 35,
    })
    expect(parseAppearancePreferences('{"version":1,"glassStrength":999}')).toMatchObject({
      glassStrength: 100,
    })
    expect(parseAppearancePreferences('{"version":1,"glassStrength":-1}')).toMatchObject({
      glassStrength: 0,
    })
    expect(parseAppearancePreferences('{"version":1,"glassStrength":"80"}')).toMatchObject({
      glassStrength: 35,
    })
  })

  it.each([null, "not json", "[]", '"value"', '{"version":2}'])(
    "returns a fresh default object for unsupported input %s",
    (raw) => {
      const parsed = parseAppearancePreferences(raw)

      expect(parsed).toEqual(DEFAULT_APPEARANCE_PREFERENCES)
      expect(parsed).not.toBe(DEFAULT_APPEARANCE_PREFERENCES)
      expect(parsed.accent).not.toBe(DEFAULT_APPEARANCE_PREFERENCES.accent)
    }
  )

  it("normalizes only six-digit hexadecimal colors", () => {
    expect(normalizeHexColor("#0a6aff")).toBe("#0A6AFF")
    expect(normalizeHexColor("0a6aFf")).toBe("#0A6AFF")
    expect(normalizeHexColor("  #171717  ")).toBe("#171717")
    expect(normalizeHexColor("#abc")).toBeNull()
    expect(normalizeHexColor("#0A6AFF00")).toBeNull()
    expect(normalizeHexColor("#GG6AFF")).toBeNull()
  })
})
