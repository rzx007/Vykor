import type {
  AccentPresetId,
  AppearancePalette,
  AppearancePreferences,
} from "./appearance-preferences"
import { normalizeHexColor } from "./appearance-preferences"

export type AppearanceColorTokens = {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  border: string
  input: string
  shellSolid: string
  uiForeground: string
  sidebarForeground: string
  sidebarMuted: string
  sidebarBorder: string
  selection: string
  selectionForeground: string
  primary: string
  primaryForeground: string
  ring: string
  accent: string
  accentForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarSelected: string
  fileLink: string
}

export const APPEARANCE_SURFACES = {
  light: { background: "#FCFCFD", foreground: "#1B1B1B" },
  dark: { background: "#181818", foreground: "#F2F2F2" },
} as const

export const ACCENT_PRESET_COLORS: Record<AccentPresetId, `#${string}`> = {
  neutral: "#525252",
  blue: "#006AFF",
  violet: "#7C3AED",
  terracotta: "#B4533C",
  green: "#15803D",
}

type Rgb = { red: number; green: number; blue: number }

function hexToRgb(color: string): Rgb {
  const value = color.slice(1)
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  }
}

function rgbToHex({ red, green, blue }: Rgb): `#${string}` {
  const channel = (value: number): string =>
    Math.round(Math.max(0, Math.min(255, value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase()

  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function relativeLuminance(color: string): number {
  const { red, green, blue } = hexToRgb(color)
  const linearize = (channel: number): number => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
}

export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function mixColors(from: string, to: string, toAmount: number): `#${string}` {
  const start = hexToRgb(from)
  const end = hexToRgb(to)
  return rgbToHex({
    red: start.red + (end.red - start.red) * toAmount,
    green: start.green + (end.green - start.green) * toAmount,
    blue: start.blue + (end.blue - start.blue) * toAmount,
  })
}

function chooseForeground(background: string): "#000000" | "#FFFFFF" {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF"
}

function ensureSurfaceContrast(color: string, surface: string, minimumRatio: number): `#${string}` {
  if (contrastRatio(color, surface) >= minimumRatio) {
    return color as `#${string}`
  }

  // 优先保持文字原来的深浅方向，避免临界明度下突然翻成反色。
  const preferredTarget =
    relativeLuminance(color) > relativeLuminance(surface) ? "#FFFFFF" : "#000000"
  const target =
    contrastRatio(preferredTarget, surface) >= minimumRatio
      ? preferredTarget
      : preferredTarget === "#FFFFFF"
        ? "#000000"
        : "#FFFFFF"
  let lower = 0
  let upper = 1

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (lower + upper) / 2
    if (contrastRatio(mixColors(color, target, middle), surface) >= minimumRatio) {
      upper = middle
    } else {
      lower = middle
    }
  }

  const adjusted = mixColors(color, target, upper)
  if (contrastRatio(adjusted, surface) >= minimumRatio) {
    return adjusted
  }

  return target
}

function ensureSurfacesContrast(
  color: string,
  surfaces: readonly string[],
  minimumRatio: number
): string {
  return surfaces.reduce(
    (adjusted, surface) => ensureSurfaceContrast(adjusted, surface, minimumRatio),
    color
  )
}

function resolveAccentColor(accent: AppearancePreferences["accent"]): `#${string}` {
  if (accent.kind === "preset") {
    return ACCENT_PRESET_COLORS[accent.id]
  }

  return normalizeHexColor(accent.value) ?? ACCENT_PRESET_COLORS.neutral
}

export function resolveAppearanceColors(
  accent: AppearancePreferences["accent"],
  theme: "light" | "dark",
  palette?: AppearancePalette
): AppearanceColorTokens {
  const color = resolveAccentColor(accent)
  const defaults = APPEARANCE_SURFACES[theme]
  const background = palette?.background ?? defaults.background
  // 只在颜色过于接近时提高文字对比度，避免自定义主题使设置本身不可读。
  const foreground = ensureSurfaceContrast(
    palette?.foreground ?? defaults.foreground,
    background,
    4.5
  )
  const darkSurface = relativeLuminance(background) < 0.18
  const elevation = darkSurface ? "#FFFFFF" : foreground
  // 中等明度背景的空间较小，限制表面变化，保证同一前景仍然可读。
  const readableSurface = (surface: string): string =>
    ensureSurfaceContrast(surface, foreground, 4.5)
  const shellSolid = readableSurface(mixColors(background, elevation, darkSurface ? 0.035 : 0.02))
  const card = readableSurface(darkSurface ? mixColors(background, "#FFFFFF", 0.025) : background)
  const popover = readableSurface(
    darkSurface ? mixColors(background, "#FFFFFF", 0.045) : background
  )
  const muted = readableSurface(mixColors(background, elevation, darkSurface ? 0.07 : 0.04))
  // shadcn 的 accent 表示轻量交互表面；用户选的强调色对应 primary。
  const weakAccent = readableSurface(mixColors(background, elevation, darkSurface ? 0.09 : 0.06))
  const sidebarAccent = readableSurface(
    mixColors(shellSolid, elevation, darkSurface ? 0.07 : 0.045)
  )
  const sidebarSelected = readableSurface(
    mixColors(shellSolid, elevation, darkSurface ? 0.12 : 0.085)
  )
  const contentSurfaces = [background, card, popover, muted, weakAccent]
  const sidebarSurfaces = [shellSolid, sidebarAccent, sidebarSelected]
  const selection = mixColors(background, elevation, 0.18)
  const primary = ensureSurfaceContrast(color, background, 3)
  const sidebarPrimary = ensureSurfaceContrast(color, shellSolid, 3)
  const ring = ensureSurfaceContrast(color, background, 3)
  const sidebarForeground = ensureSurfacesContrast(
    mixColors(shellSolid, foreground, 0.9),
    sidebarSurfaces,
    4.5
  )

  return {
    background,
    foreground,
    card,
    cardForeground: ensureSurfaceContrast(foreground, card, 4.5),
    popover,
    popoverForeground: ensureSurfaceContrast(foreground, popover, 4.5),
    secondary: muted,
    secondaryForeground: ensureSurfaceContrast(foreground, muted, 4.5),
    muted,
    mutedForeground: ensureSurfacesContrast(
      mixColors(background, foreground, 0.62),
      contentSurfaces,
      4.5
    ),
    border: mixColors(background, elevation, 0.1),
    input: mixColors(background, elevation, 0.18),
    shellSolid,
    uiForeground: ensureSurfacesContrast(
      mixColors(background, foreground, 0.9),
      contentSurfaces,
      4.5
    ),
    sidebarForeground,
    sidebarMuted: ensureSurfacesContrast(
      mixColors(shellSolid, foreground, 0.62),
      sidebarSurfaces,
      4.5
    ),
    sidebarBorder: mixColors(shellSolid, elevation, 0.1),
    selection,
    selectionForeground: ensureSurfaceContrast(foreground, selection, 4.5),
    primary,
    primaryForeground: chooseForeground(primary),
    ring,
    accent: weakAccent,
    accentForeground: ensureSurfaceContrast(foreground, weakAccent, 4.5),
    sidebarPrimary,
    sidebarPrimaryForeground: chooseForeground(sidebarPrimary),
    sidebarAccent,
    sidebarAccentForeground: ensureSurfaceContrast(foreground, sidebarAccent, 4.5),
    sidebarSelected,
    fileLink: ensureSurfacesContrast(color, contentSurfaces, 4.5),
  }
}

/** 启动和运行期共用同一组 shadcn 变量；shell / sidebar 仍由 CSS 处理玻璃材质。 */
export function applyAppearanceColors(
  root: HTMLElement,
  preferences: AppearancePreferences,
  theme: "light" | "dark"
): void {
  const colors = resolveAppearanceColors(preferences.accent, theme, preferences.colors[theme])
  for (const [token, value] of Object.entries(colors)) {
    const property = `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    root.style.setProperty(property, value)
  }
}
