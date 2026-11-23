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

export async function showComputerControlOverlay(signal: AbortSignal, onUnavailable: () => void): Promise<void> {
  signal.throwIfAborted()
  const overlays: BrowserWindow[] = []
  const ready = Promise.withResolvers<void>()
  let closed = false
  let shown = false
  const close = () => {
    closed = true
    signal.removeEventListener("abort", cancel)
    for (const overlay of overlays.splice(0)) {
      if (!overlay.isDestroyed()) overlay.destroy()
    }
  }
  const cancel = () => {
    close()
    ready.reject(signal.reason)
  }
  const fail = () => {
    if (closed) return
    close()
    if (shown) onUnavailable()
    else ready.reject(new Error("无法显示前台控制提示。"))
  }
  signal.addEventListener("abort", cancel, { once: true })
  const timeout = setTimeout(fail, 4_000)
  try {
    const displays = screen.getAllDisplays()
    if (!displays.length) throw new Error("没有可用显示器。")
    const loads = displays.map(async ({ bounds }) => {
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
      const painted = new Promise<void>(resolve => overlay.once("ready-to-show", resolve))
      await Promise.all([painted, overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)])
    })
    void Promise.all(loads).then(() => {
      if (closed) return
      for (const overlay of overlays) {
        overlay.showInactive()
        if (!overlay.isVisible()) throw new Error("前台控制提示不可见。")
      }
      shown = true
      ready.resolve()
    }).catch(fail)
  } catch {
    fail()
  }
  try {
    await ready.promise
  } finally {
    clearTimeout(timeout)
  }
}
