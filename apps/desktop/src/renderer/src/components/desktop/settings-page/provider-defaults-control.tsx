import { useEffect, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select"
import { Button } from "@renderer/components/ui/button"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"
import { errorMessage } from "./settings-error-message"

export function ProviderDefaultsControl({ onChanged }: { onChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<ProviderDefaultsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  async function load() { try { setSnapshot(await window.desktop.providerDefaults.snapshot()) } catch (failure) { setError(errorMessage(failure)) } }
  useEffect(() => { void load() }, [])
  const selected = snapshot?.models.find((item) => item.providerName === snapshot.provider && item.id === snapshot.model)
  async function choose(key: string) {
    const model = snapshot?.models.find((item) => `${item.providerName}:${item.id}` === key)
    if (!model || busy) return
    setBusy(true); setError(null); setFeedback("")
    try {
      const effort = snapshot?.effort && model.reasoningEfforts?.includes(snapshot.effort) ? snapshot.effort : ""
      const bootstrap = await window.desktop.sessions.setDefaultModel({ provider: model.providerName, model: model.id, effort })
      useDesktopSessionStore.setState({ models: bootstrap.models, defaultModel: bootstrap.defaultModel, defaultProvider: bootstrap.defaultProvider })
      await load(); await onChanged(); setFeedback("默认供应商和模型已保存，新会话采用；已有会话保留自己的模型。")
    } catch (failure) { setError(errorMessage(failure)) }
    finally { setBusy(false) }
  }
  async function chooseEffort(effort: string) {
    if (!snapshot || busy) return
    setBusy(true); setError(null)
    try { setSnapshot(await window.desktop.providerDefaults.updateEffort({ effort: effort === "_default" ? null : effort, expectedRevision: snapshot.revision })); setFeedback("默认推理强度已保存，后续请求采用；会话中明确选择的强度优先。") }
    catch (failure) { setError(errorMessage(failure)) }
    finally { setBusy(false) }
  }
  return <section className="space-y-4 border-b pb-6" aria-labelledby="provider-defaults-heading">
    <h2 id="provider-defaults-heading" className="text-base font-semibold">默认模型与请求偏好</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{feedback && <p role="status" className="text-xs text-muted-foreground">{feedback}</p>}
    {!snapshot ? <Button variant="ghost" onClick={() => void load()}>重新读取默认模型</Button> : <>
      {snapshot.disabled && <p className="text-sm text-destructive">新任务默认模型已关闭。选择一个可用模型后恢复；已有会话不会被静默切换。</p>}
      <label className="block space-y-2 text-sm"><span>默认供应商 / 模型</span><Select value={snapshot.provider && snapshot.model ? `${snapshot.provider}:${snapshot.model}` : ""} onValueChange={(key) => { if (typeof key === "string") void choose(key) }}><SelectTrigger disabled={busy || !snapshot.models.length} aria-label="默认供应商与模型"><SelectValue placeholder="请选择已配置的模型" /></SelectTrigger><SelectContent>{snapshot.models.map((model) => <SelectItem key={`${model.providerName}:${model.id}`} value={`${model.providerName}:${model.id}`}>{model.provider} / {model.label}</SelectItem>)}</SelectContent></Select></label>
      {!snapshot.models.length && <p className="text-xs text-muted-foreground">未列出可用模型，请先配置连接或重新检测。</p>}
      {selected?.reasoningEfforts?.length ? <label className="block space-y-2 text-sm"><span>默认推理强度</span><Select value={snapshot.effort && selected.reasoningEfforts.includes(snapshot.effort) ? snapshot.effort : "_default"} onValueChange={(value) => { if (typeof value === "string") void chooseEffort(value) }}><SelectTrigger disabled={busy} aria-label="默认推理强度"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="_default">不发送强度参数</SelectItem>{selected.reasoningEfforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent></Select></label> : <p className="text-xs text-muted-foreground">默认推理强度：所选模型未提供可调强度的支持信息；不会发送不支持的参数。</p>}
      {selected && <p className="text-xs text-muted-foreground">上下文范围：{selected.contextWindow ? `${selected.contextWindow.toLocaleString()} Token` : "未知"}；图片输入：{selected.inputCapabilities?.image === "native" ? "支持" : selected.inputCapabilities?.image === "unsupported" ? "不支持" : "未知"}。</p>}
      <p className="text-xs text-muted-foreground">快速模式：{snapshot.fastModeReason}</p>
    </>}
  </section>
}
