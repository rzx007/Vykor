export type DesktopWindowThemeSource = "system" | "light" | "dark"

export function isDesktopWindowThemeSource(value: unknown): value is DesktopWindowThemeSource {
  return value === "system" || value === "light" || value === "dark"
}
