import type { BrowserWindow } from "electron"

/** 关闭后的旧 WebFrame 可能仍在 frames 中；只查询当前 DOM 持有的已导航文档。 */
export async function currentPluginUiFrame(window: BrowserWindow) {
  const source: unknown = await window.webContents.executeJavaScript(
    "document.querySelector('iframe')?.src"
  )
  if (typeof source !== "string" || !source.startsWith("vykor-plugin-ui://frame/")) return
  return window.webContents.mainFrame.frames.find(
    (frame) => !frame.detached && frame.url === source
  )
}
