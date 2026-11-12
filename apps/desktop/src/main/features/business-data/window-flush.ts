import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { desktopBusinessDataService } from "./business-data-service"
const windows = new Set<WebContents>()
const readyWindows = new WeakSet<WebContents>()
const requests = new Map<string, { senderId: number; finish: (success: boolean) => void }>()
export function trackBusinessDataWindow(sender: WebContents): void {
  windows.add(sender)
  sender.once("destroyed", () => {
    windows.delete(sender)
    for (const request of requests.values())
      if (request.senderId === sender.id) request.finish(false)
  })
}
export function markBusinessDataWindowReady(senderId: number): void {
  const sender = [...windows].find((window) => window.id === senderId)
  if (sender) readyWindows.add(sender)
}
export function requestWindowBusinessDataFlush(sender: WebContents): Promise<void> {
  if (sender.isDestroyed())
    return Promise.reject(new Error("business-data window FLUSH_UNAVAILABLE"))
  if (!readyWindows.has(sender)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => finish(false), 30000)
    const finish = (success: boolean) => {
      clearTimeout(timer)
      requests.delete(id)
      if (success) resolve()
      else reject(new Error("business-data window FLUSH_FAILED"))
    }
    requests.set(id, { senderId: sender.id, finish })
    try {
      sender.send("business-data:flush-request", id)
    } catch {
      finish(false)
    }
  })
}
export function acknowledgeBusinessDataFlush(
  senderId: number,
  id: unknown,
  success: unknown
): void {
  if (typeof id !== "string") return
  const request = requests.get(id)
  if (request?.senderId === senderId) request.finish(success === true)
}
/** Migration and shutdown must call this while renderer IPC is still alive. */
export async function flushDesktopBusinessData(): Promise<void> {
  await Promise.all([...windows].map(requestWindowBusinessDataFlush))
  await desktopBusinessDataService.flush()
}
