import {
  BrowserWindow,
  clipboard,
  Menu,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron"
import type { DesktopTextMenuAction } from "../../../shared/clipboard-types"

import { IpcChannels } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"

export const clipboardIpcContribution: IpcContribution = {
  id: "clipboard",
  register() {
    return [
      {
        channel: IpcChannels.clipboardReadText,
        handler: () => clipboard.readText(),
      },
      {
        channel: IpcChannels.clipboardWriteText,
        handler: (_event, text) => clipboard.writeText(String(text)),
      },
      {
        channel: IpcChannels.clipboardShowTextMenu,
        handler: showTextMenu,
      },
    ]
  },
}

function showTextMenu(event: IpcMainInvokeEvent, input: unknown): Promise<DesktopTextMenuAction> {
  if (
    !input ||
    typeof input !== "object" ||
    !("editable" in input) ||
    typeof input.editable !== "boolean" ||
    !("hasSelection" in input) ||
    typeof input.hasSelection !== "boolean"
  )
    throw new Error("无效的文本菜单请求")
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) throw new Error("窗口不存在，无法打开文本菜单")
  const { editable, hasSelection } = input
  return new Promise((resolve) => {
    let action: DesktopTextMenuAction = null
    const items: MenuItemConstructorOptions[] = editable
      ? [
          { label: "剪切", role: "cut", enabled: hasSelection },
          { label: "复制", role: "copy", enabled: hasSelection },
          { label: "粘贴", role: "paste", enabled: clipboard.availableFormats().length > 0 },
          { type: "separator" },
          { label: "全选", role: "selectAll" },
        ]
      : [
          {
            label: "复制",
            accelerator: "CmdOrCtrl+C",
            registerAccelerator: false,
            enabled: hasSelection,
            click: () => {
              action = "copy"
            },
          },
          {
            label: "全选",
            accelerator: "CmdOrCtrl+A",
            registerAccelerator: false,
            click: () => {
              action = "select-all"
            },
          },
        ]
    Menu.buildFromTemplate(items).popup({
      window: win,
      frame: event.sender.focusedFrame ?? undefined,
      callback: () => resolve(action),
    })
  })
}
