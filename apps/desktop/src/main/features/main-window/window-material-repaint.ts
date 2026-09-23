import type { BrowserWindow } from "electron"

/** 补帧延迟。取一帧多一点（32ms ≈ 2 帧 @60Hz），让后端合成器有机会先处理完窗口 bounds 变化。 */
export const MATERIAL_REPAINT_DELAY_MS = 32

/**
 * Windows 上 acrylic 窗口的两处合成层补偿，共用同一个「有界双帧重绘」：
 *
 * - `resized`：手动拉伸结束后，Chromium 偶发只更新窗口 bounds，renderer 最后一帧没完整 repaint，
 *   新扩展出来的区域会留下宿主底色（用户看到的是一块死区）。
 * - `show`：窗口 hide 到托盘后再次 show 时，可能继续复用已经失效的合成 surface——
 *   renderer 与后端进程都还活着，但窗口只剩宿主底色。
 *
 * 处理方式：立即 invalidate 一次，32ms 后再补一次；已有 pending 定时器先清掉，保证有界。
 *
 * 禁止在这里 reload renderer / 重建 webContents / 重建会话：这是合成层问题，不是页面状态问题。
 */
export function attachWindowsMaterialRepaint(win: BrowserWindow): void {
  let pending: ReturnType<typeof setTimeout> | null = null

  const repaint = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return

    win.webContents.invalidate()

    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.invalidate()
    }, MATERIAL_REPAINT_DELAY_MS)
    pending.unref?.()
  }

  win.on("resized", repaint)
  win.on("show", repaint)
  win.once("closed", () => {
    if (!pending) return
    clearTimeout(pending)
    pending = null
  })
}
