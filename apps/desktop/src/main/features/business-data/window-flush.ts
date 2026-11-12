import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { desktopBusinessDataService } from "./business-data-service"
import { getLegacyImportFilePath } from "@vykor/host-config/paths"
import { readLegacyImportManifest } from "./legacy-import"
import { desktopOperationGate, releaseDesktopRootWriter } from "../../core/ipc/operation-gate"
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
export function requestWindowBusinessDataFlush(sender: WebContents, freeze = false): Promise<void> {
  if (sender.isDestroyed())
    return Promise.reject(new Error("business-data window FLUSH_UNAVAILABLE"))
  if (!readyWindows.has(sender)) return freeze ? Promise.reject(new Error("business-data window FLUSH_UNAVAILABLE")) : Promise.resolve()
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
      sender.send("business-data:flush-request", id, freeze)
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
export async function flushDesktopBusinessData(freeze = false): Promise<void> {
  await Promise.all([...windows].map(sender => requestWindowBusinessDataFlush(sender, freeze)))
  await desktopBusinessDataService.flush()
}

/** The migration host must freeze edits first and retain that freeze until restart/abort. */
export async function prepareDesktopBusinessDataExport(freeze = false): Promise<{
  desktopExportPath: string; scanId: string; userDataDir: string; documentsDir: string
}> {
  const desktopExportPath = getLegacyImportFilePath()
  const previous = readLegacyImportManifest(desktopExportPath).desktopScan?.id
  await flushDesktopBusinessData(freeze)
  const manifest = readLegacyImportManifest(desktopExportPath), scan = manifest.desktopScan
  if (!scan || scan.id === previous || Object.entries(scan.sources).some(([id, digest]) => {
    const source = manifest.sources[id]
    return !source || source.sourceDigest !== digest || (source.status !== "confirmed" && source.retainedSourceAcknowledged !== true)
  })) throw new Error("needs_desktop_export: Open Desktop and complete a fresh business-data scan after freezing edits.")
  return { desktopExportPath, scanId: scan.id, userDataDir: scan.userDataDir, documentsDir: scan.documentsDir }
}

/** Remains sealed after return. The old process must restart even after a recovered migration. */
export async function prepareDesktopRootMigration(pauseConnections: () => Promise<void>) {
  await desktopOperationGate.freeze()
  const receipt = await prepareDesktopBusinessDataExport(true)
  await desktopOperationGate.seal()
  await pauseConnections()
  await releaseDesktopRootWriter()
  return { ...receipt, freshDesktopScanId: receipt.scanId }
}
