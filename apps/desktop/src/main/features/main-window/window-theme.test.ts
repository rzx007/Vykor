import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopWindowThemeSource } from "../../../shared/window-theme-types"
import { createWindowThemeController } from "./window-theme"

describe("Windows native window theme", () => {
  let dir: string
  let preferencePath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vykor-window-theme-"))
    preferencePath = join(dir, "theme.json")
  })
  afterEach(() => {
    if (existsSync(preferencePath)) unlinkSync(preferencePath)
    rmdirSync(dir)
    vi.restoreAllMocks()
  })

  it.each(["dark", "light", "system"] as const)(
    "restores %s before window construction",
    (source) => {
      const nativeTheme = { themeSource: "system" as DesktopWindowThemeSource }
      const controller = createWindowThemeController({
        platform: "win32",
        nativeTheme,
        preferencePath,
      })
      controller.set(source)
      expect(nativeTheme.themeSource).toBe(source)
      const restarted = { themeSource: "system" as DesktopWindowThemeSource }
      createWindowThemeController({ platform: "win32", nativeTheme: restarted, preferencePath })
      expect(restarted.themeSource).toBe(source)
    }
  )

  it("releases the application override when returning to system mode", () => {
    const nativeTheme = { themeSource: "system" as DesktopWindowThemeSource }
    const controller = createWindowThemeController({
      platform: "win32",
      nativeTheme,
      preferencePath,
    })
    controller.set("dark")
    controller.set("light")
    controller.set("system")
    expect(nativeTheme.themeSource).toBe("system")
  })

  it.each(["broken-json", '"invalid"'])("falls back to system for %s", (content) => {
    writeFileSync(preferencePath, content)
    const nativeTheme = { themeSource: "dark" as DesktopWindowThemeSource }
    createWindowThemeController({ platform: "win32", nativeTheme, preferencePath })
    expect(nativeTheme.themeSource).toBe("system")
  })

  it.each(["darwin", "linux"] as const)("leaves the %s native theme unchanged", (platform) => {
    const nativeTheme = { themeSource: "system" as DesktopWindowThemeSource }
    createWindowThemeController({ platform, nativeTheme, preferencePath }).set("dark")
    expect(nativeTheme.themeSource).toBe("system")
    expect(existsSync(preferencePath)).toBe(false)
  })

  it("rejects invalid values without changing the native theme", () => {
    const nativeTheme = { themeSource: "system" as DesktopWindowThemeSource }
    const controller = createWindowThemeController({
      platform: "win32",
      nativeTheme,
      preferencePath,
    })
    expect(() => controller.set("invalid" as DesktopWindowThemeSource)).toThrow("未知的窗口主题")
    expect(nativeTheme.themeSource).toBe("system")
  })

  it("applies the current theme even if persisting its startup mirror fails", () => {
    const nativeTheme = { themeSource: "system" as DesktopWindowThemeSource }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const controller = createWindowThemeController({
      platform: "win32",
      nativeTheme,
      preferencePath: join(dir, "missing", "theme.json"),
    })
    controller.set("dark")
    expect(nativeTheme.themeSource).toBe("dark")
    expect(warning).toHaveBeenCalledOnce()
  })
})
