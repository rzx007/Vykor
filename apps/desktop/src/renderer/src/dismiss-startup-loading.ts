import { STARTUP_OVERLAY_ELEMENT_ID } from "./startup-overlay"

/** 应用数据就绪/失败时的「立即移除」路径；watchStartupOverlay 负责动画与 React 首帧的时机。 */
export function dismissStartupLoading(): void {
  if (typeof document === "undefined") return
  document.getElementById(STARTUP_OVERLAY_ELEMENT_ID)?.remove()
}
