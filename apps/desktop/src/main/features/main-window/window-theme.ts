import { readFileSync, writeFileSync } from "node:fs"
import {
  isDesktopWindowThemeSource,
  type DesktopWindowThemeSource,
} from "../../../shared/window-theme-types"

/** 镜像页面主题偏好，以便建窗前给 Windows Mica 设置相同的深浅色。 */
export function createWindowThemeController(options: {
  platform: NodeJS.Platform
  nativeTheme: { themeSource: DesktopWindowThemeSource }
  preferencePath: string
}): { set: (source: DesktopWindowThemeSource) => void } {
  const enabled = options.platform === "win32"
  if (enabled) {
    let restored: DesktopWindowThemeSource = "system"
    try {
      const value: unknown = JSON.parse(readFileSync(options.preferencePath, "utf8"))
      if (isDesktopWindowThemeSource(value)) restored = value
    } catch {
      // 首次启动或文件损坏时先跟随系统，页面加载后会重新同步其保存的偏好。
    }
    if (options.nativeTheme.themeSource !== restored) options.nativeTheme.themeSource = restored
  }
  return {
    set(source) {
      if (!isDesktopWindowThemeSource(source)) throw new Error("未知的窗口主题设置。")
      if (!enabled) return
      if (options.nativeTheme.themeSource !== source) options.nativeTheme.themeSource = source
      try {
        writeFileSync(options.preferencePath, JSON.stringify(source), "utf8")
      } catch (error) {
        console.warn("[window-theme] failed to persist native theme", error)
      }
    },
  }
}
