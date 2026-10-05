import { BrowserWindow } from "electron"
import { IpcChannels, type IpcInvokeMap } from "../../../shared/ipc-channels"
import type { IpcContribution, IpcHandler } from "../../core/ipc/types"
import type { AddAnnotationInput, AnnotationIdInput, SetAnnotationModeInput } from "../../../shared/browser-annotation"
import { browserAgentService } from "./browser-agent-service"

function annotationHandler(fields: string[], execute: (ownerId: number, value: Record<string, unknown>) => unknown): IpcHandler {
  return (event, input) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.webContents !== event.sender) throw new Error("Untrusted browser IPC sender.")
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("批注请求格式错误")
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) throw new Error("批注请求参数错误")
    if (typeof value.tabId !== "string" || !/^[\w-]{1,100}$/.test(value.tabId)) throw new Error("批注标签页无效")
    if (fields.includes("pageRevision") && (!Number.isSafeInteger(value.pageRevision) || (value.pageRevision as number) < 0)) throw new Error("批注页面版本无效")
    if (fields.includes("mode") && !["off", "pick", "review"].includes(value.mode as string)) throw new Error("批注模式无效")
    for (const key of ["selectionId", "annotationId"]) if (fields.includes(key) && (typeof value[key] !== "string" || !/^[\w-]{1,128}$/.test(value[key] as string))) throw new Error("批注选择无效")
    if (fields.includes("comment") && (typeof value.comment !== "string" || value.comment.length > 2000)) throw new Error("批注意见最多 2000 字")
    return execute(owner.webContents.id, value)
  }
}

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
      { channel: IpcChannels.browserReadAnnotations, handler: annotationHandler(["tabId"], (id, v) => browserAgentService.readAnnotations(id, v.tabId as string)) },
      { channel: IpcChannels.browserSetAnnotationMode, handler: annotationHandler(["tabId", "pageRevision", "mode"], (id, v) => browserAgentService.setAnnotationMode(id, v as unknown as SetAnnotationModeInput)) },
      { channel: IpcChannels.browserAddAnnotation, handler: annotationHandler(["tabId", "pageRevision", "selectionId", "comment"], (id, v) => browserAgentService.addAnnotation(id, v as unknown as AddAnnotationInput)) },
      { channel: IpcChannels.browserFocusAnnotation, handler: annotationHandler(["tabId", "pageRevision", "annotationId"], (id, v) => browserAgentService.focusAnnotation(id, v as unknown as AnnotationIdInput)) },
      { channel: IpcChannels.browserRemoveAnnotation, handler: annotationHandler(["tabId", "pageRevision", "annotationId"], (id, v) => browserAgentService.removeAnnotation(id, v as unknown as AnnotationIdInput)) },
    ]
  },
}
