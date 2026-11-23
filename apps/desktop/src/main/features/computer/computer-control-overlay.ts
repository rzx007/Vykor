import { BrowserWindow, screen } from "electron"

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Vykor 电脑操作</title>
<style>
  body { margin: 0; height: 100dvh; display: flex; justify-content: center; align-items: flex-start;
    box-sizing: border-box; border: 2px solid #60a5fa; box-shadow: inset 0 0 25px #3b82f6a8;
    color: white; font: 500 14px "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  p { margin: 12px; padding: 8px 14px; border-radius: 8px; background: #1d4ed8; }
</style>
<body><p role="status">Vykor 正在使用你的电脑 · 按 Esc 停止</p></body></html>`

export function showComputerControlOverlay(onUnavailable: () => void): () => void {
  const overlays: BrowserWindow[] = []
  let closed = false
  const close = () => {
    closed = true
    for (const overlay of overlays.splice(0)) {
      if (!overlay.isDestroyed()) overlay.destroy()
    }
  }
  const fail = () => {
    if (closed) return
    close()
    queueMicrotask(onUnavailable)
  }
  try {
    for (const { bounds } of screen.getAllDisplays()) {
      const overlay = new BrowserWindow({
        ...bounds, show: false, frame: false, transparent: true, focusable: false,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false, movable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
      })
      overlays.push(overlay)
      overlay.setIgnoreMouseEvents(true)
      overlay.setContentProtection(true)
      overlay.once("closed", fail)
      overlay.webContents.once("render-process-gone", fail)
      void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).then(() => {
        if (!closed && !overlay.isDestroyed()) overlay.showInactive()
      }).catch(fail)
    }
    if (!overlays.length) fail()
  } catch {
    fail()
  }
  return close
}
