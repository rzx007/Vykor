// apps/desktop/src/main/features/main-window/window-material.ts
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"

import {
  isGlassWindowMaterial,
  type DesktopWindowMaterialPreference,
  type DesktopWindowMaterialState,
  type DesktopWindowMaterialUnavailableReason,
} from "../../../shared/window-material-types"
import { mainWindowBackgroundColor } from "./window-background"

/**
 * 窗口底色。macOS 的 vibrancy 与 Windows 的 backgroundMaterial 都要求「窗口背景色为透明」；
 * 页面的不透明区域仍然由 renderer 自己铺（内容层 token 都是不透明的）。
 * 注意：这里刻意不配 transparent: true —— macOS 上它会让系统不画窗口阴影（官方教程原文），
 * Windows 上 frame:false + transparent:true 在 Electron 39 会失去可缩放能力并破坏 Snap（见 D2）。
 */
export const TRANSPARENT_WINDOW_BACKGROUND = "#00000000"

/** Mica 融合壁纸和系统主题；长期使用的侧栏不透出背后的其它窗口内容。 */
export const WINDOWS_WINDOW_MATERIAL = "mica" as const

export const MACOS_WINDOW_VIBRANCY = "under-window" as const

/**
 * 只有 macOS（vibrancy）和 Windows（backgroundMaterial）有系统提供的窗口材质。
 * Linux 刻意不算：它没有可移植的原生材质，只能靠「透明窗口 + 用户自己开合成器模糊」，
 * 而 KWin/GNOME 等默认不开，实际观感就是窗口漏成透明或黑底。所以 Linux 直接判为不支持，
 * 由 resolveWindowMaterialState 降级到不透明档（外观页也因此不展示该设置项）。
 */
export function supportsNativeWindowMaterial(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32"
}

/** Electron 39 没有 isSystemBackdropSupported，按系统版本和 GPU 合成兜底检测。 */
export function supportsWindowsMica(input: {
  release: string
  gpuCompositing: string | undefined
  systemBackdropSupported?: boolean
}): boolean {
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.|$)/.exec(input.release)
  if (!version || input.systemBackdropSupported === false) return false
  const major = Number(version[1]),
    build = Number(version[3])
  return (major > 10 || (major === 10 && build >= 22621)) && input.gpuCompositing === "enabled"
}

export function resolveWindowMaterialState(input: {
  platform: NodeJS.Platform
  preference: DesktopWindowMaterialPreference
  reducedTransparency: boolean
  nativeBackdropSupported?: boolean
}): DesktopWindowMaterialState {
  const solid = (
    preference: DesktopWindowMaterialPreference,
    unavailableReason: DesktopWindowMaterialUnavailableReason | null
  ): DesktopWindowMaterialState => ({
    preference,
    active: "opaque",
    unavailableReason,
    shell: "solid",
  })

  if (input.preference === "opaque") return solid("opaque", null)

  // 系统级「降低透明度」（macOS 辅助功能）开启时必须退化为不透明底。
  if (input.reducedTransparency) return solid("glass", "reduced-transparency")

  if (!supportsNativeWindowMaterial(input.platform)) {
    return solid("glass", "unsupported-platform")
  }

  if (input.platform === "win32" && input.nativeBackdropSupported === false) {
    return solid("glass", "unsupported-system")
  }

  return {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    // macOS 的 vibrancy 是稳定材质，外壳再叠一层半透明染色；
    // Windows 保持透明宿主，由 Mica 出材质，renderer 只叠加固定主题染色。
    // 走到这里只可能是 darwin / win32：Linux 已在上面按「平台不支持」降级成不透明档。
    shell: input.platform === "darwin" ? "translucent" : "transparent",
  }
}

export type MainWindowMaterialOptions = Pick<
  BrowserWindowConstructorOptions,
  | "backgroundColor"
  | "transparent"
  | "hasShadow"
  | "vibrancy"
  | "visualEffectState"
  | "backgroundMaterial"
>

export function mainWindowMaterialOptions(input: {
  platform: NodeJS.Platform
  state: DesktopWindowMaterialState
  useDarkColors: boolean
}): MainWindowMaterialOptions {
  const glass = isGlassWindowMaterial(input.state)
  const opaqueBackground = mainWindowBackgroundColor(input.useDarkColors)

  if (input.platform === "darwin") {
    // 整窗玻璃用 vibrancy: under-window。
    // visualEffectState: active 让窗口失焦时材质仍然生效；默认值会让玻璃「视觉上关掉」，看起来像坏了。
    return glass
      ? {
          backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
          vibrancy: MACOS_WINDOW_VIBRANCY,
          visualEffectState: "active",
        }
      : { backgroundColor: opaqueBackground }
  }

  if (input.platform === "win32") {
    // frame: false 由 window-chrome.ts 提供，窗口控制按钮由 renderer 自绘，避免出现两套按钮。
    return glass
      ? {
          backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
          backgroundMaterial: WINDOWS_WINDOW_MATERIAL,
        }
      : { backgroundColor: opaqueBackground, backgroundMaterial: "none" }
  }

  if (input.platform === "linux") {
    // Linux 永远走不透明档（supportsNativeWindowMaterial 不含 linux），窗口直接给主题底色：
    // 窗口不透明，外壳就不可能漏成透明。
    // transparent 是构造期选项、运行期改不了；既然 Linux 已经不可能切回玻璃档，
    // 这里也不再打开它——透明窗口反而是「漏底/黑底」这类问题的根源。
    // hasShadow: false 是因为部分窗口管理器会给 frameless 窗口画外侧阴影/描边，
    // 看起来像窗口外缘多了一条黑线。renderer 圆角本仓库没有做，因此不涉及「透明底把圆角填成直角黑底」。
    return {
      backgroundColor: opaqueBackground,
      hasShadow: false,
    }
  }

  // 不可达，防御性返回。
  return { backgroundColor: opaqueBackground }
}

/**
 * 运行期切换材质。Linux 不参与：窗口构造期就给的是不透明主题底色，
 * 而且 Linux 上材质永远解析成不透明档（外观页也不展示该设置项），这里刻意什么都不做。
 */
export function applyMainWindowMaterial(
  win: BrowserWindow,
  input: {
    platform: NodeJS.Platform
    state: DesktopWindowMaterialState
    useDarkColors: boolean
  }
): DesktopWindowMaterialState {
  if (win.isDestroyed()) return input.state

  const glass = isGlassWindowMaterial(input.state)

  if (input.platform === "darwin") {
    // 已知限制：visualEffectState 是构造期选项，Electron 39 没有 setVisualEffectState，运行期切到玻璃时无法重置它。
    win.setBackgroundColor(
      glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
    )
    win.setVibrancy(glass ? MACOS_WINDOW_VIBRANCY : null)
    return input.state
  }

  if (input.platform === "win32") {
    try {
      win.setBackgroundColor(
        glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
      )
      win.setBackgroundMaterial(glass ? WINDOWS_WINDOW_MATERIAL : "none")
      return input.state
    } catch (error) {
      // 即使系统材质调用失败，实色背景也必须盖住底层，返回状态不能继续声称透明已生效。
      console.warn("[window-material] system backdrop unavailable", error)
      win.setBackgroundColor(mainWindowBackgroundColor(input.useDarkColors))
      try {
        win.setBackgroundMaterial("none")
      } catch {
        /* 实色背景已经提供回退。 */
      }
      return {
        ...input.state,
        active: "opaque",
        shell: "solid",
        unavailableReason: "material-error",
      }
    }
  }

  // Linux：窗口构造期就是不透明底色，这里不碰底色与材质。
  return input.state
}
