import { BrowserWindow, dialog } from "electron"
import { TerminalSettingsChannels, TerminalSettingsEvents, type UpdateTerminalSettingsInput } from "../../../shared/terminal-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopTerminalSettingsService } from "./terminal-settings-service"

export const terminalSettingsIpcContribution: IpcContribution = {
  id: "terminal-settings",
  register() {
    return [
      { channel: TerminalSettingsChannels.terminalSettingsSnapshot, handler: () => desktopTerminalSettingsService.snapshot() },
      { channel: TerminalSettingsChannels.terminalSettingsUpdate, handler: (_event, input) => {
        const snapshot = desktopTerminalSettingsService.update(input as UpdateTerminalSettingsInput)
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(TerminalSettingsEvents.changed, snapshot)
        }
        return snapshot
      } },
      { channel: TerminalSettingsChannels.terminalSettingsChooseShell, handler: async () => {
        const result = await dialog.showOpenDialog({ title: "选择终端 Shell 可执行文件", properties: ["openFile"] })
        return result.canceled ? null : result.filePaths[0] ?? null
      } },
    ]
  },
}
