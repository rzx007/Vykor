import { pathToFileURL } from "node:url"
import type { IpcMainInvokeEvent } from "electron"
import type { AppContext } from "../app-context"

export function assertMainRenderer(ctx: AppContext, event: IpcMainInvokeEvent): void {
  const owner = ctx.windowManager.getMain()?.webContents
  if (
    !owner ||
    owner.isDestroyed() ||
    owner !== event.sender ||
    !event.senderFrame ||
    event.senderFrame !== owner.mainFrame
  )
    throw new Error("此操作仅可从 Vykor 主窗口发起。")
  const source = new URL(event.senderFrame.url)
  const expected = new URL(ctx.paths.rendererUrl ?? pathToFileURL(ctx.paths.indexHtml).href)
  source.hash = expected.hash = ""
  if (source.href !== expected.href) throw new Error("此操作仅可从 Vykor 主窗口发起。")
}
