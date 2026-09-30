import { describe, expect, it } from "vitest"

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  normalizeHexColor,
  parseAppearancePreferences,
} from "./appearance-preferences"

describe("appearance preferences", () => {
  it("provides the product defaults", () => {
    expect(DEFAULT_APPEARANCE_PREFERENCES).toEqual({
      version: 1,
      theme: "system",
      accent: { kind: "preset", id: "neutral" },
      uiFont: "inter",
      codeFont: "geist-mono",
      uiFontSize: 14,
      codeFontSize: 14,
      reducedMotion: "system",
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
      uiFont: "inter",
      codeFont: "consolas",
      uiFontSize: 16,
      codeFontSize: 15,
      reducedMotion: "on",
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
      uiFont: "inter",
      codeFont: "geist-mono",
      uiFontSize: 14,
      codeFontSize: 14,
      reducedMotion: "system",
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
