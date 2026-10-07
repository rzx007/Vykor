import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Switch } from "@renderer/components/ui/switch"
import { Checkbox } from "@renderer/components/ui/checkbox"
import type { SettingsImportPreview } from "@shared/configuration-settings-types"
import { errorMessage } from "./settings-error-message"

const groups = [{ id: "general", label: "常规" }, { id: "permission", label: "权限" }, { id: "memory", label: "自定义指令和记忆偏好" }, { id: "model", label: "默认模型" }, { id: "environment", label: "运行环境" }]
export function ConfigurationSettings() {
  const [review, setReview] = useState<"off" | "risk_based" | null>(null)
  const [selected, setSelected] = useState<string[]>(["general"])
  const [preview, setPreview] = useState<SettingsImportPreview | null>(null)
  const [importGroups, setImportGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  useEffect(() => { let cancelled = false; void window.desktop.configurationSettings.review().then(value => { if (!cancelled) setReview(value.mode) }).catch(failure => { if (!cancelled) setError(errorMessage(failure)) }); return () => { cancelled = true } }, [])
  async function run(operation: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await operation() } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) } }
  return <div className="flex flex-col gap-8">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor="auto-review-mode">完成后自动检查</FieldLabel><FieldDescription>按风险执行只读审查；不修改代码、不运行测试，也不会把任务完成状态改成失败。默认关闭，后续任务采用。</FieldDescription></FieldContent><Switch id="auto-review-mode" disabled={busy || review === null} checked={review === "risk_based"} onCheckedChange={enabled => void run(async () => { const result = await window.desktop.configurationSettings.updateReview({ mode: enabled ? "risk_based" : "off", expected: review! }); setReview(result.mode); setNotice("完成后检查设置已保存。") })} /></Field>
    <section aria-labelledby="configuration-transfer-heading" className="flex flex-col gap-4"><h2 id="configuration-transfer-heading" className="text-base font-semibold">配置导入和导出</h2><p className="text-sm text-muted-foreground">文件不含供应商和渠道凭据、请求头、环境变量、会话内容。所选自定义指令会包含在文件中，请自行保管。</p>
      <FieldGroup>{groups.map(group => <Field key={group.id} orientation="horizontal"><Checkbox id={`export-${group.id}`} disabled={busy} checked={selected.includes(group.id)} onCheckedChange={checked => setSelected(current => checked ? [...current, group.id] : current.filter(id => id !== group.id))} /><FieldLabel htmlFor={`export-${group.id}`}>{group.label}</FieldLabel></Field>)}</FieldGroup>
      <div className="flex gap-2"><Button variant="outline" disabled={busy || !selected.length} onClick={() => void run(async () => { const path = await window.desktop.configurationSettings.exportFile(selected); if (path) setNotice(`已导出到 ${path}`) })}>导出选定配置</Button><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const value = await window.desktop.configurationSettings.previewImport(); setPreview(value); setImportGroups(value?.groups.map(group => group.id) ?? []) })}>选择导入文件</Button></div>
      {preview ? <div className="flex flex-col gap-4"><p className="text-sm">导入预览 · {preview.name}</p><FieldGroup>{preview.groups.map(group => <Field key={group.id}><Field orientation="horizontal"><Checkbox id={`import-${group.id}`} disabled={busy} checked={importGroups.includes(group.id)} onCheckedChange={checked => setImportGroups(current => checked ? [...current, group.id] : current.filter(id => id !== group.id))} /><FieldLabel htmlFor={`import-${group.id}`}>{group.label}</FieldLabel></Field><details className="text-sm text-muted-foreground"><summary>查看修改内容</summary>{group.changes.map(change => <p key={change.key} className="mt-2 break-words">{change.key}：{change.before} → {change.after}</p>)}</details></Field>)}</FieldGroup><p className="text-sm text-muted-foreground">应用会覆盖选定分类的用户默认值，包括其中的权限规则；运行环境需重启后台后生效。取消不会改变配置。</p><div className="flex gap-2"><Button disabled={busy || !importGroups.length} onClick={() => void run(async () => { await window.desktop.configurationSettings.applyImport({ id: preview.id, categories: importGroups }); setPreview(null); setReview((await window.desktop.configurationSettings.review()).mode); setNotice("配置已导入。请重新读取对应设置；运行环境重启后台后采用。") })}>确认应用导入配置</Button><Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>取消导入</Button></div></div> : null}
    </section>
  </div>
}
