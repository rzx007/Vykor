import type { AppearancePreferences, CodeFontId, UiFontId } from "./appearance-preferences"

export type AppearanceFontOption<Id extends string> = {
  id: Id
  label: string
  source: "bundled" | "system-generic" | "local"
  family: string
  checkQuery?: string
}

/**
 * 中文回退链：只在前面的拉丁字体缺字时生效，保证各平台中文落到确定的字体上。
 * 与 assets/main.css 的 @theme 字体栈保持一致。
 */
const CJK_SANS_FALLBACK =
  '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'
const CJK_MONO_FALLBACK = '"Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", monospace'

export const UI_FONT_OPTIONS: readonly AppearanceFontOption<UiFontId>[] = [
  {
    id: "system",
    label: "系统默认",
    source: "system-generic",
    family: `"Segoe UI Variable Text", "Segoe UI", ${CJK_SANS_FALLBACK}`,
  },
  {
    id: "inter",
    label: "Inter",
    source: "bundled",
    family: `"Inter Variable", Inter, ${CJK_SANS_FALLBACK}`,
  },
  {
    id: "segoe-ui",
    label: "Segoe UI",
    source: "local",
    family: `"Segoe UI Variable Text", "Segoe UI", ${CJK_SANS_FALLBACK}`,
    checkQuery: '12px "Segoe UI Variable Text"',
  },
]

export const CODE_FONT_OPTIONS: readonly AppearanceFontOption<CodeFontId>[] = [
  {
    id: "geist-mono",
    label: "Geist Mono",
    source: "bundled",
    family: `"Geist Mono Variable", ${CJK_MONO_FALLBACK}`,
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    source: "local",
    family: `"Cascadia Code", "Geist Mono Variable", Consolas, ${CJK_MONO_FALLBACK}`,
    checkQuery: '12px "Cascadia Code"',
  },
  {
    id: "cascadia-mono",
    label: "Cascadia Mono",
    source: "local",
    family: `"Cascadia Mono", "Geist Mono Variable", Consolas, ${CJK_MONO_FALLBACK}`,
    checkQuery: '12px "Cascadia Mono"',
  },
  {
    id: "consolas",
    label: "Consolas",
    source: "local",
    family: `Consolas, "Geist Mono Variable", ${CJK_MONO_FALLBACK}`,
    checkQuery: '12px "Consolas"',
  },
]

const ALL_FONT_OPTIONS: readonly AppearanceFontOption<string>[] = [
  ...UI_FONT_OPTIONS,
  ...CODE_FONT_OPTIONS,
]

export async function detectLocalFontAvailability(
  check: (query: string) => boolean
): Promise<Record<string, boolean>> {
  const availability: Record<string, boolean> = {}

  for (const option of ALL_FONT_OPTIONS) {
    if (option.source !== "local" || !option.checkQuery) {
      continue
    }

    try {
      availability[option.id] = check(option.checkQuery)
    } catch {
      availability[option.id] = false
    }
  }

  return availability
}

function isUnavailableLocalFont(
  option: AppearanceFontOption<string>,
  availability: Readonly<Record<string, boolean>>
): boolean {
  return option.source === "local" && availability[option.id] === false
}

export function repairUnavailableFonts(
  preferences: AppearancePreferences,
  availability: Readonly<Record<string, boolean>>
): AppearancePreferences {
  const selectedUiFont = UI_FONT_OPTIONS.find((option) => option.id === preferences.uiFont)
  const selectedCodeFont = CODE_FONT_OPTIONS.find((option) => option.id === preferences.codeFont)
  const repairUiFont = selectedUiFont && isUnavailableLocalFont(selectedUiFont, availability)
  const repairCodeFont = selectedCodeFont && isUnavailableLocalFont(selectedCodeFont, availability)

  if (!repairUiFont && !repairCodeFont) {
    return preferences
  }

  return {
    ...preferences,
    uiFont: repairUiFont ? "inter" : preferences.uiFont,
    codeFont: repairCodeFont ? "geist-mono" : preferences.codeFont,
  }
}
