export type DesktopWindowMaterialPreference = "glass" | "opaque"

/** 材质实际是否生效；"opaque" 既可能是用户选的，也可能是系统侧不支持后的降级。 */
export type DesktopWindowMaterialActive = "glass" | "opaque"

export type DesktopWindowMaterialUnavailableReason = "unsupported-platform" | "reduced-transparency"

/**
 * renderer 外壳（`--shell`）该用什么底：
 * - "solid"：不透明档，token 保持原值；
 * - "translucent"：玻璃 + macOS，vibrancy 之上再叠一层半透明染色；
 * - "transparent"：玻璃 + Windows/Linux，默认全透明，让原生材质（Acrylic / 合成器模糊）
 *   直接可见——材质只在 web 内容透明处才透得出来；应用主题与系统主题不一致时由 CSS 叠一层主题色，
 *   因为背板跟随的是系统主题。
 */
export type DesktopWindowMaterialShell = "solid" | "translucent" | "transparent"

export interface DesktopWindowMaterialState {
  preference: DesktopWindowMaterialPreference
  active: DesktopWindowMaterialActive
  /** 只有「用户选了玻璃但没生效」时才有值，用于外观页说明原因。 */
  unavailableReason: DesktopWindowMaterialUnavailableReason | null
  shell: DesktopWindowMaterialShell
}

export const DEFAULT_WINDOW_MATERIAL_PREFERENCE: DesktopWindowMaterialPreference = "glass"

export const WINDOW_MATERIAL_ARGUMENT_PREFIX = "--openharness-window-material="
export const WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX = "--openharness-window-material-active="
export const WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX = "--openharness-window-material-reason="
export const WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX = "--openharness-window-material-shell="
export const NO_WINDOW_MATERIAL_REASON = "none"

const PREFERENCES = new Set<DesktopWindowMaterialPreference>(["glass", "opaque"])
const ACTIVE_VALUES = new Set<DesktopWindowMaterialActive>(["glass", "opaque"])
const REASONS = new Set<DesktopWindowMaterialUnavailableReason>([
  "unsupported-platform",
  "reduced-transparency",
])
const SHELL_VALUES = new Set<DesktopWindowMaterialShell>(["solid", "translucent", "transparent"])

export function isDesktopWindowMaterialPreference(
  value: unknown
): value is DesktopWindowMaterialPreference {
  return typeof value === "string" && PREFERENCES.has(value as DesktopWindowMaterialPreference)
}

export function isGlassWindowMaterial(state: DesktopWindowMaterialState): boolean {
  return state.active === "glass"
}

/**
 * 主进程建窗口时把结论塞进 webPreferences.additionalArguments，preload 再同步读回来。
 * 走 argv 而不是 IPC 是因为 renderer 首帧就必须知道玻璃是否真的生效，异步 IPC 会先出一帧错误底色。
 */
export function windowMaterialArguments(state: DesktopWindowMaterialState): string[] {
  return [
    `${WINDOW_MATERIAL_ARGUMENT_PREFIX}${state.preference}`,
    `${WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX}${state.active}`,
    `${WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX}${state.unavailableReason ?? NO_WINDOW_MATERIAL_REASON}`,
    `${WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX}${state.shell}`,
  ]
}

/** 只有主窗口会带这四个参数；宠物窗口等其它入口返回 null。 */
export function parseWindowMaterialArguments(
  argv: readonly string[]
): DesktopWindowMaterialState | null {
  const preference = readArgument(argv, WINDOW_MATERIAL_ARGUMENT_PREFIX)
  const active = readArgument(argv, WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX)
  const reason = readArgument(argv, WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX)
  const shell = readArgument(argv, WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX)

  if (!isDesktopWindowMaterialPreference(preference)) return null
  if (typeof active !== "string" || !ACTIVE_VALUES.has(active as DesktopWindowMaterialActive)) {
    return null
  }
  if (reason === null) return null
  if (
    reason !== NO_WINDOW_MATERIAL_REASON &&
    !REASONS.has(reason as DesktopWindowMaterialUnavailableReason)
  ) {
    return null
  }
  if (shell === null || !SHELL_VALUES.has(shell as DesktopWindowMaterialShell)) return null

  return {
    preference,
    active: active as DesktopWindowMaterialActive,
    unavailableReason:
      reason === NO_WINDOW_MATERIAL_REASON
        ? null
        : (reason as DesktopWindowMaterialUnavailableReason),
    shell: shell as DesktopWindowMaterialShell,
  }
}

function readArgument(argv: readonly string[], prefix: string): string | null {
  const match = argv.find((value) => value.startsWith(prefix))
  return match === undefined ? null : match.slice(prefix.length)
}
