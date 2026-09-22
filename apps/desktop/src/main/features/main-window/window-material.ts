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

/**
 * Windows 材质名。选 acrylic 而不是 mica：acrylic 实时模糊窗口背后的动态内容，
 * 效果最接近 macOS 的 under-window vibrancy；mica 只采样桌面壁纸，窗口背后移动的内容不会跟着变。
 * 代价是拖动窗口时 DWM 持续重算模糊，低端 GPU 可能掉帧。若要换成 mica，只改这一处。
 */
export const WINDOWS_WINDOW_MATERIAL = "acrylic" as const

export const MACOS_WINDOW_VIBRANCY = "under-window" as const

export function supportsNativeWindowMaterial(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux"
}

export function resolveWindowMaterialState(input: {
  platform: NodeJS.Platform
  preference: DesktopWindowMaterialPreference
  reducedTransparency: boolean
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

  return {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    // macOS 的 vibrancy 是稳定材质，外壳再叠一层半透明染色；
    // Windows/Linux 必须把外壳全部让出来（transparent），否则系统材质会被不透明的壳层盖住。
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
    // 实机风险：不设 transparent 时 Acrylic 可能不生效（D2），任务 9 有专门验收与降级处置。
    return glass
      ? {
          backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
          backgroundMaterial: WINDOWS_WINDOW_MATERIAL,
        }
      : { backgroundColor: opaqueBackground }
  }

  // Linux 没有可移植的原生材质，只能靠透明窗口 + 桌面合成器自带模糊（KWin 等，需用户开启）。
  // 这里两档位都无条件透明：transparent 是构造期选项、运行期改不了，
  // 若在不透明档位用不透明窗口，用户之后切回玻璃就必须重启；而 renderer 在不透明档位会自己铺满底色，
  // 所以「始终透明」两档位都正确。hasShadow: false 是因为部分窗口管理器会给 frameless 窗口画外侧阴影/描边，
  // 看起来像窗口外缘多了一条黑线。renderer 圆角本仓库没有做，因此不涉及「透明底把圆角填成直角黑底」。
  return {
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
    transparent: true,
    hasShadow: false,
  }
}

/**
 * 运行期切换材质。Linux 的 transparent 只能构造期指定，这里刻意什么都不做：
 * 窗口始终是透明底，外壳观感完全由 renderer 的 data-window-shell 负责
 * （把底色改成不透明反而会在透明窗口上产生无法预测的结果）。
 */
export function applyMainWindowMaterial(
  win: BrowserWindow,
  input: {
    platform: NodeJS.Platform
    state: DesktopWindowMaterialState
    useDarkColors: boolean
  }
): void {
  if (win.isDestroyed()) return

  const glass = isGlassWindowMaterial(input.state)

  if (input.platform === "darwin") {
    win.setBackgroundColor(
      glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
    )
    win.setVibrancy(glass ? MACOS_WINDOW_VIBRANCY : null)
    return
  }

  if (input.platform === "win32") {
    win.setBackgroundColor(
      glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
    )
    // 运行期设置是兜底：Electron 36 之前存在「动态 setBackgroundMaterial 不生效」的 bug
    // （electron/electron#47386），构造期激活也有历史 bug（#46657）。
    win.setBackgroundMaterial(glass ? WINDOWS_WINDOW_MATERIAL : "none")
    return
  }

  // Linux：不碰底色与材质，只由 renderer 的 data-window-shell 决定观感。
}
