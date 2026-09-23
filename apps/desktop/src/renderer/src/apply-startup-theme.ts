import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreferences,
} from "./components/appearance/appearance-preferences"
import {
  isGlassWindowMaterial,
  type DesktopWindowMaterialState,
} from "@shared/window-material-types"

export function applyStartupTheme(root: HTMLElement = document.documentElement): void {
  try {
    const preferences = parseAppearancePreferences(localStorage.getItem(APPEARANCE_STORAGE_KEY))
    const prefersDark =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    const resolved =
      preferences.theme === "system" ? (prefersDark ? "dark" : "light") : preferences.theme
    root.classList.remove("light", "dark")
    root.classList.add(resolved)
  } catch {
    // Keep the CSS prefers-color-scheme fallback if storage or parsing fails.
  }

  applyWindowMaterialToRoot(root)
}

/** 读 preload 注入的同步快照；宠物窗口等没有注入时返回 null。 */
export function readWindowMaterialSnapshot(): DesktopWindowMaterialState | null {
  if (typeof window === "undefined") return null
  return window.desktop?.window?.material ?? null
}

/** 写给定状态。Provider 运行期切换也用它——argv 快照不会更新，不能靠重读快照。 */
export function writeWindowMaterialAttributes(
  root: HTMLElement,
  state: DesktopWindowMaterialState
): void {
  root.dataset.windowMaterial = isGlassWindowMaterial(state) ? "glass" : "opaque"
  root.dataset.windowShell = state.shell
}

/** 启动时按快照写属性；没有快照（宠物窗口）就清掉可能残留的属性。 */
export function applyWindowMaterialToRoot(root: HTMLElement = document.documentElement): void {
  const snapshot = readWindowMaterialSnapshot()
  if (!snapshot) {
    delete root.dataset.windowMaterial
    delete root.dataset.windowShell
    return
  }

  writeWindowMaterialAttributes(root, snapshot)
}
