import { createHash } from "node:crypto"
import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { safeStorage } from "electron"

import {
  DEFAULT_TERMINAL_SETTINGS,
  validateTerminalSettings,
  type TerminalSettings,
  type TerminalSettingsSnapshot,
  type UpdateTerminalSettingsInput,
} from "../../../shared/terminal-settings-types"
import { normalizeDefaultTerminalShellId } from "../../../shared/settings-types"
import { getDesktopPreferences, patchDesktopPreferences } from "./desktop-preferences"
import { listDetectedTerminalShells } from "../terminal/detect-shells"

function revision(settings: TerminalSettings, shell: string | null): string {
  return createHash("sha256").update(JSON.stringify({ settings, shell })).digest("hex")
}

export function terminalShellFileError(executable: string): string | null {
  try {
    if (!isAbsolute(executable) || !statSync(executable).isFile()) return "请选择存在的 Shell 可执行文件绝对路径。"
    accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return null
  } catch { return `Shell 文件不可用：${executable}。请重新选择。` }
}

export const desktopTerminalSettingsService = {
  snapshot(): TerminalSettingsSnapshot {
    const preferences = getDesktopPreferences()
    const settings = preferences.terminal ?? DEFAULT_TERMINAL_SETTINGS
    const defaultTerminalShellId = preferences.defaultTerminalShellId ?? null
    const shellError = settings.customShell
      ? terminalShellFileError(settings.customShell.executable)
      : defaultTerminalShellId && !listDetectedTerminalShells().some((entry) => entry.id === defaultTerminalShellId)
        ? `已保存的 Shell（${defaultTerminalShellId}）未检测到，请重新选择或恢复系统默认。`
        : null
    return {
      settings: { ...settings, environment: settings.environment.map((entry) => entry.secret ? { name: entry.name, value: "", secret: true, hasValue: true } : entry) },
      defaultTerminalShellId, revision: revision(settings, defaultTerminalShellId), shellError,
      secretStorageAvailable: safeStorage.isEncryptionAvailable(),
    }
  },

  update(input: UpdateTerminalSettingsInput): TerminalSettingsSnapshot {
    if (!input || input.expectedRevision !== this.snapshot().revision) throw new Error("终端设置已被其他窗口修改，请重新读取后比较并重试。")
    const settings = validateTerminalSettings(input.settings)
    if (input.defaultTerminalShellId !== null && (typeof input.defaultTerminalShellId !== "string" || !normalizeDefaultTerminalShellId(input.defaultTerminalShellId))) throw new Error("默认 Shell 选择无效。")
    const shellId = normalizeDefaultTerminalShellId(input.defaultTerminalShellId) ?? null
    const preferences = getDesktopPreferences()
    const startupChanged = shellId !== (preferences.defaultTerminalShellId ?? null) || JSON.stringify(settings.customShell) !== JSON.stringify(preferences.terminal?.customShell ?? null)
    if (settings.customShell && startupChanged) {
      const error = terminalShellFileError(settings.customShell.executable)
      if (error) throw new Error(error)
    } else if (!settings.customShell && shellId && startupChanged && !listDetectedTerminalShells().some((entry) => entry.id === shellId)) throw new Error("该 Shell 已不可用，请重新检测并选择。")
    const previous = preferences.terminal?.environment ?? []
    settings.environment = settings.environment.map((entry) => {
      if (!entry.secret) {
        if (entry.hasValue) throw new Error("从机密变量改为普通变量时，请重新输入值。")
        return { name: entry.name, value: entry.value, secret: false }
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统机密存储不可用，无法保存终端机密变量。")
      if (!entry.value && entry.hasValue) {
        const saved = previous.find((item) => item.name === entry.name && item.secret)
        if (!saved) throw new Error(`请重新填写 ${entry.name} 的机密值。`)
        return saved
      }
      return { name: entry.name, secret: true, value: safeStorage.encryptString(entry.value).toString("base64") }
    })
    patchDesktopPreferences({ terminal: settings, defaultTerminalShellId: shellId })
    return this.snapshot()
  },

  launchEnvironment(): Record<string, string> {
    return Object.fromEntries((getDesktopPreferences().terminal?.environment ?? []).map((entry) => [
      entry.name,
      entry.secret ? safeStorage.decryptString(Buffer.from(entry.value, "base64")) : entry.value,
    ]))
  },
}
