import { app, dialog } from "electron"
import { dataRootHome, readDataRootSelector, requireCompleteAbsolutePath, withDataRootRecoveryLock } from "@vykor/host-config/paths"
import { recoverDataRootMigration } from "@vykor/server/daemon-host"

/** Recovery runs in a new process before any writer/store/client or normal startup guard. */
export async function runDesktopDataRootRecovery(argv: string[]): Promise<void> {
  const homeDir = dataRootHome()
  if (argv.length === 1 && argv[0] === "--startup-lock") {
    await withDataRootRecoveryLock(homeDir, async () => {
      const pending = readDataRootSelector(homeDir)?.pendingMigration
      if (pending) throw new Error(`请运行 Vykor data-root recover --journal "${pending.journalPath}"`)
    }, { timeoutMs: 500 })
  } else {
    if (argv.length !== 2 || argv[0] !== "--journal") throw new Error("使用 Vykor data-root recover --journal <完整记录路径> 或 Vykor data-root recover --startup-lock。")
    const result = await recoverDataRootMigration(requireCompleteAbsolutePath(argv[1]!, "--journal"), { homeDir })
    console.info(JSON.stringify(result))
    if (result.phase === "rollback_failed") throw new Error(`恢复尚未完成；保留现场并重试同一记录：${result.journalPath}`)
  }
  await app.whenReady()
  await dialog.showMessageBox({ type: "info", title: "本机数据根恢复", message: "恢复检查已完成，请重新启动 Desktop。旧副本和迁移记录已保留。" })
  app.quit()
}
