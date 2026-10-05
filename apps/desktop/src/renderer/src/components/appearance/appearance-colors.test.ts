import { describe, expect, it } from "vitest"

import type { AppearancePreferences } from "./appearance-preferences"
import { APPEARANCE_SURFACES, contrastRatio, resolveAppearanceColors } from "./appearance-colors"

const accents: AppearancePreferences["accent"][] = [
  { kind: "preset", id: "neutral" },
  { kind: "preset", id: "blue" },
  { kind: "preset", id: "violet" },
  { kind: "preset", id: "terracotta" },
  { kind: "preset", id: "green" },
  { kind: "custom", value: "#006AFF" },
  { kind: "custom", value: "#808080" },
  { kind: "custom", value: "#FFFF00" },
  { kind: "custom", value: "#050505" },
]

describe("appearance color derivation", () => {
  it.each(["light", "dark"] as const)(
    "returns a complete, accessible token set in %s mode",
    (theme) => {
      for (const accent of accents) {
        const tokens = resolveAppearanceColors(accent, theme)

        expect(contrastRatio(tokens.primary, tokens.primaryForeground)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(tokens.sidebarPrimary, tokens.sidebarPrimaryForeground)
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.accent, tokens.accentForeground)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(tokens.sidebarAccent, tokens.sidebarAccentForeground)
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.primary, tokens.background)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(tokens.fileLink, tokens.background)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.ring, tokens.background)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(tokens.sidebarPrimary, tokens.shellSolid)).toBeGreaterThanOrEqual(3)
      }
    }
  )

  it.each(["light", "dark"] as const)(
    "keeps hover and selection independent of the action color in %s mode",
    (theme) => {
      const tokens = resolveAppearanceColors({ kind: "custom", value: "#006AFF" }, theme)
      const other = resolveAppearanceColors({ kind: "custom", value: "#B4533C" }, theme)

      expect(tokens.primary).not.toBe(other.primary)
      expect(tokens.accent).toBe(other.accent)
      expect(tokens.sidebarAccent).toBe(other.sidebarAccent)
      expect(tokens.sidebarSelected).toBe(other.sidebarSelected)
      expect(tokens.selection).toBe(other.selection)
      expect(tokens.sidebarSelected).not.toBe(tokens.sidebarAccent)
    }
  )

  it.each(["light", "dark"] as const)(
    "uses the selected background and foreground in %s mode",
    (theme) => {
      const tokens = resolveAppearanceColors({ kind: "preset", id: "blue" }, theme, {
        background: theme === "light" ? "#EFF1F5" : "#282A36",
        foreground: theme === "light" ? "#4C4F69" : "#F8F8F2",
      })
      expect(tokens.background).toBe(theme === "light" ? "#EFF1F5" : "#282A36")
      expect(tokens.foreground).toBe(theme === "light" ? "#4C4F69" : "#F8F8F2")
      expect(tokens.shellSolid).not.toBe(tokens.background)
      expect(tokens.background).not.toBe(APPEARANCE_SURFACES[theme].background)
      for (const [text, surface] of [
        [tokens.foreground, tokens.background],
        [tokens.mutedForeground, tokens.background],
        [tokens.sidebarForeground, tokens.shellSolid],
        [tokens.sidebarMuted, tokens.shellSolid],
        [tokens.sidebarForeground, tokens.sidebarSelected],
        [tokens.selectionForeground, tokens.selection],
      ]) {
        expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it("keeps custom text readable even when the chosen colors are too close", () => {
    const tokens = resolveAppearanceColors({ kind: "custom", value: "#FFFF00" }, "light", {
      background: "#EEEEEE",
      foreground: "#DDDDDD",
    })
    expect(tokens.background).toBe("#EEEEEE")
    expect(contrastRatio(tokens.foreground, tokens.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(tokens.mutedForeground, tokens.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(tokens.fileLink, tokens.background)).toBeGreaterThanOrEqual(4.5)
  })

  it("calculates WCAG contrast ratios from sRGB colors", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21)
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.478, 3)
    expect(contrastRatio("#006AFF", "#FFFFFF")).toBeCloseTo(4.661, 3)
  })

  it.each(["#333333", "#666666", "#777777", "#999999", "#A58C70"])(
    "keeps shared text readable on derived surfaces for %s",
    (background) => {
      const tokens = resolveAppearanceColors({ kind: "preset", id: "blue" }, "dark", {
        background: background as `#${string}`,
        foreground: "#F2F2F2",
      })
      for (const surface of [
        tokens.background,
        tokens.card,
        tokens.popover,
        tokens.muted,
        tokens.accent,
      ]) {
        expect(contrastRatio(tokens.mutedForeground, surface)).toBeGreaterThanOrEqual(4.5)
      }
      for (const surface of [tokens.shellSolid, tokens.sidebarSelected, tokens.sidebarAccent]) {
        expect(contrastRatio(tokens.sidebarForeground, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.sidebarMuted, surface)).toBeGreaterThanOrEqual(4.5)
      }
    }
  )
})
