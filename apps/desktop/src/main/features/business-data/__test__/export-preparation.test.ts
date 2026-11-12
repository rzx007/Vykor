import { afterEach, expect, it } from "vitest"
import { join } from "node:path"
import { prepareDesktopBusinessDataExport, trackBusinessDataWindow, markBusinessDataWindowReady, acknowledgeBusinessDataFlush } from "../window-flush"
import { desktopBusinessDataService } from "../business-data-service"
const cleanup: Array<() => void> = []
afterEach(() => { for (const destroy of cleanup.splice(0)) destroy() })
const host = () => ({ userDataDir: join(process.env.USERPROFILE!, "electron"), documentsDir: join(process.env.USERPROFILE!, "Documents") })
it("does not accept an old empty receipt when no renderer completed a fresh scan", async () => {
  await desktopBusinessDataService.recordDesktopScan({}, host())
  await expect(prepareDesktopBusinessDataExport()).rejects.toThrow(/needs_desktop_export/)
})
it("waits for a new scan after renderer flush and returns the bound export location", async () => {
  const sender = {
    id: 306, isDestroyed: () => false,
    once: (_name: string, destroy: () => void) => { cleanup.push(destroy) },
    send: (_name: string, id: string) => {
      void desktopBusinessDataService.recordDesktopScan({}, host()).then(() => acknowledgeBusinessDataFlush(306, id, true))
    },
  }
  trackBusinessDataWindow(sender as never); markBusinessDataWindowReady(sender.id)
  const result = await prepareDesktopBusinessDataExport()
  expect(result).toMatchObject({ desktopExportPath: join(process.env.VYKOR_CONFIG_DIR!, "data", "desktop", "legacy-import.json"), ...host() })
  expect(result.scanId).toBeTruthy()
})
