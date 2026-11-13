import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import type { DataRootInfo, DataRootPreview, DataRootOperation } from "@shared/maintenance-settings-types"
import { recordLegacyBusinessScan } from "@renderer/lib/business-data"

export function DataRootSettings() {
  const api = window.desktop.maintenance
  const [info, setInfo] = useState<DataRootInfo | null>(null), [target, setTarget] = useState("")
  const [preview, setPreview] = useState<DataRootPreview | null>(null), [result, setResult] = useState<DataRootOperation | null>(null)
  const [journal, setJournal] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("")
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("")
    try { await work() } catch (error) { setError(error instanceof Error ? error.message : "本机维护未完成，请保留旧数据并重试。") }
    finally { setBusy(false) }
  }
  useEffect(() => { void act(async () => setInfo(await api.dataRootInfo())) }, [])
  return <section className="flex flex-col gap-3" aria-label="用户数据根">
    <h2 className="text-sm font-semibold">用户数据根</h2>
    <p className="text-xs text-muted-foreground">会话、草稿、附件、凭据、插件和工作目录共同使用的整根目录。迁移后关闭旧窗口并重新启动；临时聊天不会保留，活动任务和终端须先结束。旧副本默认保留。</p>
    <p className="text-xs break-all">当前实际路径：{info?.currentRoot ?? "读取中…"}（来源：{info?.source ?? "未知"}）</p>
    <div className="flex gap-2"><Input aria-label="目标用户数据根" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setPreview(null) }} placeholder="完整目标根路径；选择整根目录" />
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const path = await api.chooseDirectory(); if (path) { setTarget(path); setPreview(null) } })}>选择整根目录</Button></div>
    {info?.unresolvedComposer ? <div className="flex flex-col gap-2 text-xs" role="status">
      <p>有 {info.unresolvedComposer.count} 个旧会话无法归属（session-not-found）。这些草稿不会导出，原浏览器副本继续保留在 {info.retainedProfile} 的原业务键中。</p>
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => {
        await window.desktop.businessData.acknowledgeUnresolvedComposer(info.unresolvedComposer!.sourceDigest)
        await recordLegacyBusinessScan(); setInfo(await api.dataRootInfo()); setPreview(null)
      })}>保留这些旧副本并继续</Button>
    </div> : null}
    <div className="flex gap-2">
      <Button variant="outline" disabled={busy || !target} onClick={() => void act(async () => setPreview(await api.inspectDataRoot(target)))}>只读预览</Button>
      <Button disabled={busy || !preview || !!info?.unresolvedComposer || preview.blockers.some(item => !["needs_desktop_export", "git_main_ownership_pending"].includes(item.code))} onClick={() => void act(async () => setResult(await api.migrateDataRoot(target)))}>迁移整根并重启</Button>
    </div>
    {busy ? <p role="status" className="text-xs">正在处理本机数据，请保留窗口…</p> : null}
    {preview ? <div className="flex flex-col gap-2 text-xs"><p className="break-all">从 {preview.sourceRoot} 到 {preview.targetRoot}；复制 {preview.files} 个文件，预计至少 {preview.bytes} 字节独立空间。</p>
      {preview.blockers.map((item, index) => <p key={index} className="break-all">冲突 {item.code}：{item.path} {item.message}</p>)}
      <details><summary className="cursor-pointer">迁移清单与重启影响</summary>{preview.entries.map((item, index) => <p key={index} className="break-all">{item.source} → {item.target}（{item.bytes} 字节）</p>)}{preview.impacts.map((item, index) => <p key={index}>{item}</p>)}</details>
    </div> : null}
    <details className="text-xs"><summary className="cursor-pointer">按迁移记录恢复</summary><p>旧窗口须结束。系统会在新的本机维护进程核对记录后恢复。死亡启动锁且没有记录时，运行 data-root recover --startup-lock。</p>
      <Input aria-label="迁移记录完整路径" value={journal} disabled={busy} onChange={event => setJournal(event.target.value)} />
      <Button variant="outline" disabled={busy || !journal} onClick={() => void act(async () => setResult(await api.recoverDataRoot(journal)))}>关闭窗口并恢复</Button>
    </details>
    {result ? <p role="status" className="text-xs break-all">步骤：{result.failedOperation ?? result.operation ?? result.phase}；当前可使用的根：{result.usableRoot}；恢复记录：{result.journalPath ?? "未创建"}。{result.error}</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive break-all">{error}</p> : null}
  </section>
}
