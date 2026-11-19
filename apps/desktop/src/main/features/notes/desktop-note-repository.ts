import { join } from "node:path"
import { app } from "electron"
import {
  dataRootHome,
  getDataDir,
  getDataRoot,
  getInitializedDataRootInputs,
} from "@vykor/host-config/paths"
import { openDesktopNoteRepository } from "@vykor/services/notes"
import { prepareLegacyNoteImport } from "./legacy-note-import"

export async function openDesktopNotes(directory: string) {
  await prepareLegacyNoteImport({
    dataRoot: getDataRoot(),
    dataDirectory: getDataDir(),
    homeDirectory: getInitializedDataRootInputs()?.homeDir ?? dataRootHome(),
    legacyDataLocationPath: join(app.getPath("userData"), "runtime-data-location.json"),
    destination: directory,
    flushRecovery: async () => {
      const { flushDesktopRecoveryDrafts } = await import("../business-data/window-flush")
      await flushDesktopRecoveryDrafts()
    },
    onDaemonStopped: async () => {
      const { desktopSessionService } = await import("../session/session-service")
      await desktopSessionService.connection.dispose()
    },
  })
  return openDesktopNoteRepository(directory)
}
