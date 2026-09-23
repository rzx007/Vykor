import { BrowserWindow } from "electron"
import { IpcChannels, type IpcInvokeMap } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { browserAgentService } from "./browser-agent-service"

export const browserIpcContribution: IpcContribution = {
  id: "browser",
  register() {
    return [
      {
        channel: IpcChannels.browserTabUpdate,
        handler: (event, input) => {
          const owner = BrowserWindow.fromWebContents(event.sender)
          if (!owner || owner.webContents !== event.sender)
            throw new Error("Untrusted browser IPC sender.")
          const value = input as IpcInvokeMap[typeof IpcChannels.browserTabUpdate]["args"][0]
          if (value.action === "bind")
            browserAgentService.bindTab(owner.webContents.id, value.tabId, value.webContentsId)
          else if (value.action === "active")
            browserAgentService.setActiveTab(owner.webContents.id, value.tabId)
          else browserAgentService.unbindTab(owner.webContents.id, value.tabId)
        },
      },
      {
        channel: IpcChannels.browserInspectAt,
        handler: async (event, input) => {
          const owner = BrowserWindow.fromWebContents(event.sender)
          if (!owner || owner.webContents !== event.sender)
            throw new Error("Untrusted browser IPC sender.")
          const value = input as IpcInvokeMap[typeof IpcChannels.browserInspectAt]["args"][0]
          return await browserAgentService.inspectAt(
            owner.webContents.id,
            value.tabId,
            value.x,
            value.y
          )
        },
      },
      {
        channel: IpcChannels.browserAddAnnotation,
        handler: (event, input) => {
          const owner = BrowserWindow.fromWebContents(event.sender)
          if (!owner || owner.webContents !== event.sender)
            throw new Error("Untrusted browser IPC sender.")
          const value = input as IpcInvokeMap[typeof IpcChannels.browserAddAnnotation]["args"][0]
          browserAgentService.addAnnotation(owner.webContents.id, value.tabId, value)
        },
      },
    ]
  },
}
