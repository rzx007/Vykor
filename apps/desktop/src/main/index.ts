import { app, dialog } from "electron"
import { join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { configureLinuxInputMethod } from "./core/linux-input-method"
import { registerDocumentPreviewScheme } from "./features/workspace/document-preview-protocol"
import { registerPluginAppScheme } from "./features/plugin-apps/document-protocol"
import { acquireDataRootWriter, assertNoLegacyDirectoryOverrides, dataRootHome, getInitializedDataRootInputs, initializeDataRoot, parseDataRootArgument, readDataRootSelector, resolveUserDataPaths } from "@vykor/host-config/paths"

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
  if (parsed.argv[0] === "data-root" && parsed.argv[1] === "recover") {
    await (await import("./data-root-recovery-entry")).runDesktopDataRootRecovery(parsed.argv.slice(2)); return
  }
  const selected = await initializeDataRoot({ explicitRoot: parsed.explicitRoot })
  const daemon = parsed.argv.some(arg => ["--daemon-service", "--daemon-watchdog", "--daemon-on-demand"].includes(arg))
  let maintenance = parsed.argv[0] === "data-root"
  try { assertNoLegacyDirectoryOverrides(selected.dataRoot) }
  catch (error) { if (daemon) throw error; maintenance = true }
  if (!daemon && !maintenance) {
    const { readRegisteredDataLocation } = await import("@vykor/server/daemon-host")
    const saved = await readRegisteredDataLocation(join(selected.dataRoot, "data"), join(app.getPath("userData"), "runtime-data-location.json"))
    if (saved && resolve(saved.storePath) !== resolve(join(selected.dataRoot, "data/session-runtime/sessions.db"))) maintenance = true
    const { readLegacyImportManifest } = await import("./features/business-data/legacy-import")
    const paths = resolveUserDataPaths(selected.dataRoot), receipt = readLegacyImportManifest(paths.legacyImportFilePath).legacySources
    const original = getInitializedDataRootInputs()?.environment ?? {}
    if (receipt?.status === "pending" && (!existsSync(paths.sessionsDatabasePath)
      || (receipt.environment.VYKOR_CHANNELS_DIR && original.VYKOR_CHANNELS_DIR === undefined)
      || (receipt.environment.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR && original.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR === undefined))) maintenance = true
  }
  if (maintenance) {
    process.argv = [...process.argv.slice(0, hostArgOffset), ...parsed.argv]
    await (await import("./data-root-maintenance")).startDataRootMaintenance(); return
  }
  const writer = await acquireDataRootWriter({ homeDir: dataRootHome(), dataRoot: selected.dataRoot, kind: daemon ? "daemon" : "desktop" })
  if (!daemon) (await import("./core/ipc/operation-gate")).setDesktopRootWriter(writer)
  process.argv = [...process.argv.slice(0, hostArgOffset), ...parsed.argv]
  console.info(`[data-root] ${selected.dataRoot} (source: ${selected.source})`)
  await import("./application")
}

void main().catch(async (error: unknown) => {
  console.error("[data-root] Desktop startup stopped", error)
  if (!process.argv.some(arg => ["--daemon-service", "--daemon-watchdog", "--daemon-on-demand", "--internal-data-root-validation"].includes(arg))) {
    let journal: string | undefined
    try { journal = readDataRootSelector(dataRootHome())?.pendingMigration?.journalPath } catch { /* Preserve malformed selectors. */ }
    await app.whenReady()
    if (journal) {
      const choice = await dialog.showMessageBox({ type: "warning", title: "用户数据根需要恢复", buttons: ["按本次记录恢复", "关闭"], defaultId: 1, cancelId: 1,
        message: `普通启动已停止，没有创建新数据库。\n迁移记录：${journal}\n可运行 Vykor data-root recover --journal "${journal}"。` })
      if (choice.response === 0) {
        try { await (await import("./data-root-recovery-entry")).runDesktopDataRootRecovery(["--journal", journal]); return }
        catch { dialog.showErrorBox("恢复未完成", `保留所有副本后重试同一迁移记录：${journal}`) }
      }
    } else dialog.showErrorBox("用户数据根启动已停止", "请核对本机预检与根定位记录；若仅为已死亡的启动锁，运行 Vykor data-root recover --startup-lock。活锁与无法核对的锁不会被解除。")
  }
  app.exit(1)
})
