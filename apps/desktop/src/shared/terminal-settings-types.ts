export interface TerminalEnvironmentVariable {
  name: string
  value: string
  secret: boolean
  /** 机密值存在但不会返回明文；空输入保留已保存值。 */
  hasValue?: boolean
}

export interface TerminalSettings {
  version: 1
  customShell: { executable: string; args: string[] } | null
  wslShell: string
  wslShellArgs: string[]
  environment: TerminalEnvironmentVariable[]
  fontMode: "code" | "independent"
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorStyle: "block" | "bar" | "underline"
  cursorBlink: boolean
  confirmMultilinePaste: boolean
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  version: 1, customShell: null, wslShell: "", wslShellArgs: [], environment: [],
  fontMode: "code", fontFamily: "Consolas", fontSize: 13, scrollback: 5000,
  cursorStyle: "block", cursorBlink: true, confirmMultilinePaste: true,
}

export interface TerminalSettingsSnapshot {
  settings: TerminalSettings
  defaultTerminalShellId: string | null
  revision: string
  shellError: string | null
  secretStorageAvailable: boolean
}

export interface UpdateTerminalSettingsInput {
  settings: TerminalSettings
  defaultTerminalShellId: string | null
  expectedRevision: string
}

export const TerminalSettingsChannels = {
  terminalSettingsSnapshot: "terminal-settings:snapshot",
  terminalSettingsUpdate: "terminal-settings:update",
  terminalSettingsChooseShell: "terminal-settings:choose-shell",
} as const

export const TerminalSettingsEvents = { changed: "terminal-settings:changed" } as const

export interface TerminalSettingsIpcMap {
  [TerminalSettingsChannels.terminalSettingsSnapshot]: { args: []; result: TerminalSettingsSnapshot }
  [TerminalSettingsChannels.terminalSettingsUpdate]: { args: [input: UpdateTerminalSettingsInput]; result: TerminalSettingsSnapshot }
  [TerminalSettingsChannels.terminalSettingsChooseShell]: { args: []; result: string | null }
}

export interface TerminalSettingsAPI {
  snapshot(): Promise<TerminalSettingsSnapshot>
  update(input: UpdateTerminalSettingsInput): Promise<TerminalSettingsSnapshot>
  chooseShell(): Promise<string | null>
  onChanged(listener: (snapshot: TerminalSettingsSnapshot) => void): () => void
}

export function validateTerminalSettings(value: unknown): TerminalSettings {
  if (!value || typeof value !== "object") throw new Error("终端设置格式无效。")
  const input = value as TerminalSettings
  if (input.version !== 1) throw new Error("终端设置版本不受支持。")
  const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max && !v.includes("\0")
  const args = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every((entry) => text(entry))
  if (input.customShell !== null && (!input.customShell || !text(input.customShell.executable) || !input.customShell.executable.trim() || !args(input.customShell.args))) throw new Error("自定义 Shell 需要有效的可执行文件和分开的参数。")
  if (!text(input.wslShell) || !args(input.wslShellArgs) || (input.wslShell && !input.wslShell.startsWith("/"))) throw new Error("WSL Shell 使用 Linux 绝对路径，参数需逐项填写。")
  if (input.fontMode !== "code" && input.fontMode !== "independent") throw new Error("字体选择无效。")
  if (!text(input.fontFamily, 256) || !input.fontFamily.trim()) throw new Error("请填写终端字体。")
  if (!Number.isInteger(input.fontSize) || input.fontSize < 10 || input.fontSize > 24) throw new Error("终端字号必须为 10–24 px。")
  if (!Number.isInteger(input.scrollback) || input.scrollback < 1000 || input.scrollback > 100000) throw new Error("滚动历史必须为 1,000–100,000 行。")
  if (!["block", "bar", "underline"].includes(input.cursorStyle)) throw new Error("光标形状无效。")
  if (typeof input.cursorBlink !== "boolean" || typeof input.confirmMultilinePaste !== "boolean") throw new Error("终端开关值无效。")
  if (!Array.isArray(input.environment) || input.environment.length > 100) throw new Error("终端变量最多 100 项。")
  const names = new Set<string>()
  for (const entry of input.environment) {
    if (!entry || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) || !text(entry.value, 32768) || typeof entry.secret !== "boolean" || names.has(entry.name.toUpperCase())) throw new Error("环境变量名称重复或格式无效。")
    names.add(entry.name.toUpperCase())
  }
  return {
    version: 1,
    customShell: input.customShell ? { executable: input.customShell.executable.trim(), args: [...input.customShell.args] } : null,
    wslShell: input.wslShell.trim(), wslShellArgs: [...input.wslShellArgs],
    environment: input.environment.map(({ name, value, secret, hasValue }) => ({ name, value, secret, ...(hasValue ? { hasValue: true } : {}) })),
    fontMode: input.fontMode, fontFamily: input.fontFamily.trim(), fontSize: input.fontSize,
    scrollback: input.scrollback, cursorStyle: input.cursorStyle, cursorBlink: input.cursorBlink,
    confirmMultilinePaste: input.confirmMultilinePaste,
  }
}
