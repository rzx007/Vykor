import { Menu, type BrowserWindow } from "electron"
import { createWindowsApps, type WindowsAppWindow } from "./windows-apps"
import { createWindowsForeground } from "./windows-foreground"

/** Window selection stays in the native menu. Only the selected picture reaches the draft. */
export async function shareWindowsPicture(window: BrowserWindow, signal: AbortSignal): Promise<{ bytes: Uint8Array } | null> {
  const windows = await createWindowsApps().visibleWindows(signal)
  signal.throwIfAborted()
  if (!windows.length) throw new Error("没有可分享的窗口。请打开并恢复要分享的应用。")
  const selected = await new Promise<WindowsAppWindow | undefined>(resolve => {
    let choice: WindowsAppWindow | undefined
    const menu = Menu.buildFromTemplate(windows.map((candidate, index) => ({
      // Ampersands are Electron menu access keys, so escape them in window titles.
      label: `${index + 1}. ${candidate.title.replace(/\p{Cc}/gu, "").slice(0, 150).replaceAll("&", "&&")}` +
        (candidate.position && windows.some(other => other !== candidate && other.title === candidate.title)
          ? `（屏幕位置 ${candidate.position.left}, ${candidate.position.top}）` : ""),
      click: () => { choice = candidate },
    })))
    const abort = (): void => { menu.closePopup(window); resolve(undefined) }
    signal.addEventListener("abort", abort, { once: true })
    menu.popup({ window, callback: () => {
      signal.removeEventListener("abort", abort)
      resolve(choice)
    } })
  })
  signal.throwIfAborted()
  if (!selected) return null
  const frame = await createWindowsForeground().capture(selected, signal)
  signal.throwIfAborted()
  return { bytes: Buffer.from(frame.data, "base64") }
}
