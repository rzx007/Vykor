export const APPEARANCE_STORAGE_KEY = "vykor-desktop-appearance-v1"

export const UI_FONT_SIZE_RANGE = { min: 12, max: 18 } as const
export const CODE_FONT_SIZE_RANGE = { min: 11, max: 18 } as const

export type AppearanceTheme = "system" | "light" | "dark"
export type AccentPresetId = "neutral" | "blue" | "violet" | "terracotta" | "green"
export type UiFontId = "system" | "segoe-ui" | "inter"
export type CodeFontId = "cascadia-code" | "cascadia-mono" | "geist-mono" | "consolas"
export type ReducedMotionPreference = "system" | "on" | "off"

export type AppearancePreferences = {
  version: 1
  theme: AppearanceTheme
  accent: { kind: "preset"; id: AccentPresetId } | { kind: "custom"; value: `#${string}` }
  uiFont: UiFontId
  codeFont: CodeFontId
  uiFontSize: number
  codeFontSize: number
  reducedMotion: ReducedMotionPreference
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  version: 1,
  theme: "system",
  accent: { kind: "preset", id: "neutral" },
  uiFont: "system",
  codeFont: "geist-mono",
  uiFontSize: 14,
  codeFontSize: 13,
  reducedMotion: "system",
}

const THEMES = new Set<AppearanceTheme>(["system", "light", "dark"])
const ACCENT_PRESETS = new Set<AccentPresetId>(["neutral", "blue", "violet", "terracotta", "green"])
const UI_FONTS = new Set<UiFontId>(["system", "segoe-ui", "inter"])
const CODE_FONTS = new Set<CodeFontId>(["cascadia-code", "cascadia-mono", "geist-mono", "consolas"])
const REDUCED_MOTION_VALUES = new Set<ReducedMotionPreference>(["system", "on", "off"])

function createDefaultPreferences(): AppearancePreferences {
  return {
    ...DEFAULT_APPEARANCE_PREFERENCES,
    accent: { ...DEFAULT_APPEARANCE_PREFERENCES.accent },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSetMember<T extends string>(values: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === "string" && values.has(value as T)
}

function normalizeFontSize(
  value: unknown,
  fallback: number,
  range: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

function parseAccent(value: unknown): AppearancePreferences["accent"] {
  if (!isRecord(value)) {
    return { ...DEFAULT_APPEARANCE_PREFERENCES.accent }
  }

  if (value.kind === "preset" && isSetMember(ACCENT_PRESETS, value.id)) {
    return { kind: "preset", id: value.id }
  }

  if (value.kind === "custom" && typeof value.value === "string") {
    const normalized = normalizeHexColor(value.value)
    if (normalized) {
      return { kind: "custom", value: normalized }
    }
  }

  return { ...DEFAULT_APPEARANCE_PREFERENCES.accent }
}

export function normalizeHexColor(value: string): `#${string}` | null {
  const candidate = value.trim().replace(/^#/, "")
  if (!/^[0-9A-Fa-f]{6}$/.test(candidate)) {
    return null
  }

  return `#${candidate.toUpperCase()}`
}

export function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (raw === null) {
    return createDefaultPreferences()
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return createDefaultPreferences()
  }

  if (!isRecord(value) || value.version !== 1) {
    return createDefaultPreferences()
  }

  const defaults = createDefaultPreferences()
  return {
    version: 1,
    theme: isSetMember(THEMES, value.theme) ? value.theme : defaults.theme,
    accent: parseAccent(value.accent),
    uiFont: isSetMember(UI_FONTS, value.uiFont) ? value.uiFont : defaults.uiFont,
    codeFont: isSetMember(CODE_FONTS, value.codeFont) ? value.codeFont : defaults.codeFont,
    uiFontSize: normalizeFontSize(value.uiFontSize, defaults.uiFontSize, UI_FONT_SIZE_RANGE),
    codeFontSize: normalizeFontSize(
      value.codeFontSize,
      defaults.codeFontSize,
      CODE_FONT_SIZE_RANGE
    ),
    reducedMotion: isSetMember(REDUCED_MOTION_VALUES, value.reducedMotion)
      ? value.reducedMotion
      : defaults.reducedMotion,
  }
}
