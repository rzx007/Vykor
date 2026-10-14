import type { DesktopWindowMaterialState } from "@shared/window-material-types"

export function windowMaterialDescription(
  state: DesktopWindowMaterialState | null,
  platform?: string
): string {
  if (!state) return "窗口背景使用当前设备默认外观。"
  if (platform === "win32") {
    if (state.preference === "opaque") return "侧边栏使用实色背景，颜色跟随当前主题。"
    if (state.unavailableReason === "unsupported-system")
      return "当前系统或图形环境不支持半透明侧边栏，已使用实色背景。"
    if (state.unavailableReason === "reduced-transparency")
      return "系统已关闭透明效果或开启高对比度，已使用实色背景。"
    if (state.unavailableReason === "material-error")
      return "暂时无法应用半透明效果，已使用实色背景。"
    return "侧边栏融合桌面壁纸与主题颜色，正文保持实色。"
  }
  if (state.active === "glass") {
    return "窗口背景使用系统原生材质，桌面内容会被系统模糊后透进来。"
  }
  if (state.preference === "opaque") {
    return "窗口背景使用不透明底色，与系统窗口主题保持一致。"
  }
  if (state.unavailableReason === "reduced-transparency") {
    return "系统已开启「降低透明度」，窗口背景已回退为不透明。"
  }
  return "当前系统不提供原生窗口材质，窗口背景已回退为不透明。"
}
