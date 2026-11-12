import { app } from "electron"
import { configureLinuxInputMethod } from "./core/linux-input-method"
import { registerDocumentPreviewScheme } from "./features/workspace/document-preview-protocol"
import { registerPluginAppScheme } from "./features/plugin-apps/document-protocol"
import { acquireDataRootWriter, assertNoLegacyDirectoryOverrides, dataRootHome, initializeDataRoot, parseDataRootArgument } from "@vykor/host-config/paths"

// Electron reads schemes and Chromium switches before ready. These modules only
// hold in-memory document maps; persistent product stores are loaded below.
if (!process.argv.some(arg => ["--daemon-service", "--daemon-watchdog", "--daemon-on-demand"].includes(arg))) {
  configureLinuxInputMethod(app.commandLine, process.platform)
  registerDocumentPreviewScheme()
  registerPluginAppScheme()
  if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals")
}

async function main(): Promise<void> {
  const hostArgOffset = app.isPackaged ? 1 : 2
  if (process.argv[hostArgOffset] === "--internal-data-root-validation") {
    await (await import("@vykor/server/migration-validation")).runMigrationValidationEntry(); return
  }
  const parsed = parseDataRootArgument(process.argv.slice(hostArgOffset))
  const selected = await initializeDataRoot({ explicitRoot: parsed.explicitRoot })
  assertNoLegacyDirectoryOverrides(selected.dataRoot)
  const daemon = parsed.argv.some(arg => ["--daemon-service", "--daemon-watchdog", "--daemon-on-demand"].includes(arg))
  const writer = await acquireDataRootWriter({ homeDir: dataRootHome(), dataRoot: selected.dataRoot, kind: daemon ? "daemon" : "desktop" })
  if (!daemon) (await import("./core/ipc/operation-gate")).setDesktopRootWriter(writer)
  process.argv = [...process.argv.slice(0, hostArgOffset), ...parsed.argv]
  console.info(`[data-root] ${selected.dataRoot} (source: ${selected.source})`)
  await import("./application")
}

void main().catch((error: unknown) => {
  console.error("[data-root] Desktop startup stopped", error)
  app.exit(1)
})
