import { useEffect, useState } from "react"
import { DataRootSettings } from "./components/desktop/settings-page/storage/data-root-settings"
import { importOtherLegacyBusinessData, recordLegacyBusinessScan } from "./lib/business-data"
import { readComposerRecovery } from "./stores/desktop-session/composer-recovery"
import { markStartupOverlayReady } from "./startup-overlay"

export default function DataRootMaintenance() {
  const [ready, setReady] = useState(false), [error, setError] = useState("")
  useEffect(() => { markStartupOverlayReady() }, [])
  useEffect(() => { void (async () => {
    await readComposerRecovery()
    await importOtherLegacyBusinessData()
    await recordLegacyBusinessScan()
    setReady(true)
  })().catch(() => setError("旧业务数据未能安全导出，请保留原数据；查看本机预检冲突后重试。")) }, [])
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8"><h1 className="text-xl font-semibold">本机用户数据根维护</h1>
    <p className="text-sm text-muted-foreground">当前仅运行旧业务数据导出与整根维护。来源由本机宿主核对，旧浏览器键默认保留。</p>
    {error ? <p role="alert">{error}</p> : ready ? <DataRootSettings /> : <p role="status">正在分类并导出旧业务数据…</p>}
  </main>
}
