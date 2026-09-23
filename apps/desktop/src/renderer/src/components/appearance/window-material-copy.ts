import type { DesktopWindowMaterialState } from "@shared/window-material-types"

export function windowMaterialDescription(state: DesktopWindowMaterialState | null): string {
  if (!state) return "窗口背景使用当前设备默认外观。"
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
