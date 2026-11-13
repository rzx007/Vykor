import { app, dialog } from "electron"
import { dirname, join } from "node:path"
import { lstat } from "node:fs/promises"
import { dataRootHome, getDataRoot, getInitializedDataRootInputs, getInitializedDataRootSelection, isWithinManagedPath, readDataRootSelector, requireCompleteAbsolutePath, resolveManagedRealPath, resolveUserDataPaths, type InitializedDataRootInputs } from "@vykor/host-config/paths"
import { DaemonSystemService, inspectDataRootMigration, migrateDataRootAndRestart, recoverDataRootMigration, type DataRootMigrationRequest } from "@vykor/server/daemon-host"
import { prepareDesktopRootMigration, resumeDesktopAfterFailedExport } from "../business-data/window-flush"
import { readLegacyImportManifest } from "../business-data/legacy-import"
import { getGitSettings } from "./git-settings-storage"
import type { DataRootInfo, DataRootOperation } from "../../../shared/maintenance-settings-types"

let maintenanceOnly = false
let restartRequired = false
export function setDataRootMaintenanceMode(): void { maintenanceOnly = true }
export function isDataRootMigrationShutdown(): boolean { return restartRequired }
export function dataRootRelaunchEnvironment(inherited: NodeJS.ProcessEnv, original: InitializedDataRootInputs | undefined): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const key of ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"] as const) {
    delete env[key]
    if (original?.environment[key] !== undefined) env[key] = original.environment[key]
  }
  return env
}
export function desktopDataRootRequest(target: string): DataRootMigrationRequest {
  const rootInputs = getInitializedDataRootInputs()
  return { homeDir: dataRootHome(), sourceRoot: getDataRoot(), targetRoot: requireCompleteAbsolutePath(target, "用户数据目标根"),
    rootInputs, environment: rootInputs?.environment ?? {}, desktopExportPath: resolveUserDataPaths(getDataRoot()).legacyImportFilePath,
    legacy: { documentsDir: app.getPath("documents"), userDataDir: app.getPath("userData") } }
}
export function dataRootInfo(): DataRootInfo {
  const partial = readLegacyImportManifest(resolveUserDataPaths(getDataRoot()).legacyImportFilePath).sources.composer
  return { currentRoot: getDataRoot(), source: getInitializedDataRootSelection()?.source ?? "host", retainedProfile: app.getPath("userData"),
    unresolvedComposer: partial?.status === "partial" && !partial.retainedSourceAcknowledged
      ? { count: partial.unresolvedSessionIds.length, reason: "session-not-found", sourceDigest: partial.sourceDigest } : null }
}
export async function inspectDesktopDataRoot(target: string) { return inspectDataRootMigration(desktopDataRootRequest(target)) }
function invocation(args: string[]) { return { command: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...args], cwd: dirname(process.execPath) } }
function service(root: string, logsDir: string) { return new DaemonSystemService({ homeDir: dataRootHome(), logsDir, invocation: invocation(["--data-root", root, process.platform === "win32" ? "--daemon-watchdog" : "--daemon-service"]) }) }
async function pauseDesktopConnections(): Promise<void> {
  restartRequired = true
  if (maintenanceOnly) return
  const { desktopSessionService } = await import("../session/session-service")
  desktopSessionService.activitySubscriptions.clearAll()
  await desktopSessionService.connection.freezeForDataRootMigration()
}
export function relaunchDesktopAtRoot(root: string): void {
  const env = dataRootRelaunchEnvironment(process.env, getInitializedDataRootInputs())
  for (const key of ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"]) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]
  }
  app.relaunch({ args: [...(app.isPackaged ? [] : [app.getAppPath()]), "--data-root", root] })
  app.quit()
}
export async function migrateDesktopDataRoot(target: string): Promise<DataRootOperation> {
  const request = desktopDataRootRequest(target), preview = await inspectDataRootMigration(request)
  if (preview.blockers.some(blocker => !["needs_desktop_export", "git_main_ownership_pending"].includes(blocker.code)) || dataRootInfo().unresolvedComposer)
    throw new Error("迁移预检未通过，请处理预览中的冲突和未归属草稿后重试。")
  let result: DataRootOperation
  const sourceIdentity = await lstat(request.sourceRoot)
  let exportAttempted = false, sourceRecovered = false
  try {
    getGitSettings()
    const runtime = preview.sources.filter(source => source.origin === "runtime-data" && preview.databases.some(database => isWithinManagedPath(database.path, source.from))).sort((a, b) => b.from.length - a.from.length)[0]
    const migrated = await migrateDataRootAndRestart(request, { systemService: service(request.sourceRoot, runtime ? join(runtime.from, "logs") : resolveUserDataPaths(request.sourceRoot).logsDir),
      validation: invocation(["--internal-data-root-validation"]), target: invocation(["--data-root", request.targetRoot, "--daemon-on-demand"]),
      prepareDesktop: async () => {
        exportAttempted = true
        const receipt = await prepareDesktopRootMigration(pauseDesktopConnections)
        return receipt
      } })
    result = { ...migrated, usableRoot: migrated.writersReleased ? request.targetRoot : request.sourceRoot }
    sourceRecovered = migrated.recoveryWritersReleased === true
  } catch {
    const selector = readDataRootSelector(request.homeDir)
    result = { phase: "failed", usableRoot: selector?.dataRoot ?? request.sourceRoot, ...(selector?.pendingMigration ? { journalPath: selector.pendingMigration.journalPath } : {}), error: "迁移未完成；请保留当前可用根与迁移记录，按记录恢复。" }
  }
  if (exportAttempted && !restartRequired && !sourceRecovered) {
    let pending = readDataRootSelector(request.homeDir)?.pendingMigration
    while (pending) {
      const choice = await dialog.showMessageBox({ type: "warning", title: "草稿未保存，原根尚未恢复", buttons: ["重试按记录恢复", "保留冻结窗口"], defaultId: 1, cancelId: 1,
        message: `内存草稿仍保留。恢复记录：${pending.journalPath}\n恢复成功前不会重新放行写入。也可运行 vk data-root recover --journal "${pending.journalPath}"。` })
      if (choice.response !== 0) break
      try {
        const recovered = await recoverDataRootMigration(pending.journalPath, { homeDir: request.homeDir })
        sourceRecovered = recovered.recoveryWritersReleased === true
        result = { ...recovered, usableRoot: request.sourceRoot }
      } catch { /* Keep the in-memory draft and repeat this bounded, journal-specific recovery choice. */ }
      pending = readDataRootSelector(request.homeDir)?.pendingMigration
      if (sourceRecovered) break
    }
  }
  if (exportAttempted && !restartRequired && sourceRecovered) {
    const selector = readDataRootSelector(request.homeDir), current = await lstat(request.sourceRoot)
    if (!selector?.pendingMigration && (!selector || await resolveManagedRealPath(selector.dataRoot) === await resolveManagedRealPath(request.sourceRoot))
      && current.isDirectory() && !current.isSymbolicLink() && current.dev === sourceIdentity.dev && current.ino === sourceIdentity.ino) {
      resumeDesktopAfterFailedExport()
      result.error = "业务草稿未保存，迁移已停止且原根已恢复。请重试保存后再迁移。"
    }
  }
  if (restartRequired) {
    const next = result
    setTimeout(() => { void (async () => {
      if (next.phase !== "committed" || next.startup !== "ready") await dialog.showMessageBox({ type: "warning", title: "数据根迁移结果", message: `步骤：${next.failedOperation ?? next.operation ?? next.phase}；当前根：${next.usableRoot}\n迁移记录：${next.journalPath ?? "未创建"}\n${next.error ?? "将关闭旧窗口并重新启动。"}` })
      relaunchDesktopAtRoot(next.usableRoot)
    })() }, 0)
  }
  return result
}
export async function recoverDesktopDataRoot(journal: string): Promise<DataRootOperation> {
  requireCompleteAbsolutePath(journal, "迁移记录")
  await prepareDesktopRootMigration(pauseDesktopConnections)
  setTimeout(() => {
    const env = dataRootRelaunchEnvironment(process.env, getInitializedDataRootInputs())
    for (const key of ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]
    }
    app.relaunch({ args: [...(app.isPackaged ? [] : [app.getAppPath()]), "data-root", "recover", "--journal", journal] })
    app.quit()
  }, 0)
  return { phase: "restarting-for-recovery", usableRoot: getDataRoot(), journalPath: journal }
}
