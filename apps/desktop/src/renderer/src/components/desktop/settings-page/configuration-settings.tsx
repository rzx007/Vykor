import { useState } from "react"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Checkbox } from "@renderer/components/ui/checkbox"
import type { SettingsImportPreview } from "@shared/configuration-settings-types"
import { errorMessage } from "./settings-error-message"

const groups = [
  { id: "general", label: "对话与任务偏好" },
  { id: "permission", label: "权限" },
  { id: "memory", label: "自定义指令和记忆偏好" },
  { id: "model", label: "默认模型" },
  { id: "environment", label: "运行环境" },
]
export function ConfigurationSettings({ onImported }: { onImported?: () => void } = {}) {
  const [selected, setSelected] = useState<string[]>(["general"])
  const [preview, setPreview] = useState<SettingsImportPreview | null>(null)
  const [importGroups, setImportGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  async function run(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await operation()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <section aria-labelledby="configuration-transfer-heading" className="flex flex-col gap-4">
        <h3 id="configuration-transfer-heading" className="text-sm font-medium">
          配置导入和导出
        </h3>
        <p className="text-sm text-muted-foreground">
          迁移任务与模型设置，不含外观、通知等本机偏好。自定义指令会一并导出，请妥善保管。
        </p>
        <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {groups.map((group) => (
            <Field key={group.id} orientation="horizontal">
              <Checkbox
                id={`export-${group.id}`}
                disabled={busy}
                checked={selected.includes(group.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked ? [...current, group.id] : current.filter((id) => id !== group.id)
                  )
                }
              />
              <FieldLabel htmlFor={`export-${group.id}`}>{group.label}</FieldLabel>
            </Field>
          ))}
        </FieldGroup>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy || !selected.length}
            onClick={() =>
              void run(async () => {
                const path = await window.desktop.configurationSettings.exportFile(selected)
                if (path) setNotice(`已导出到 ${path}`)
              })
            }
          >
            导出选定配置
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await window.desktop.configurationSettings.previewImport()
                setPreview(value)
                setImportGroups(value?.groups.map((group) => group.id) ?? [])
              })
            }
          >
            选择导入文件
          </Button>
        </div>
        {preview ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm">导入预览 · {preview.name}</p>
            <FieldGroup>
              {preview.groups.map((group) => (
                <Field key={group.id}>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`import-${group.id}`}
                      disabled={busy}
                      checked={importGroups.includes(group.id)}
                      onCheckedChange={(checked) =>
                        setImportGroups((current) =>
                          checked ? [...current, group.id] : current.filter((id) => id !== group.id)
                        )
                      }
                    />
                    <FieldLabel htmlFor={`import-${group.id}`}>{group.label}</FieldLabel>
                  </Field>
                  <details className="text-sm text-muted-foreground">
                    <summary>查看修改内容</summary>
                    {group.changes.map((change) => (
                      <p key={change.key} className="mt-2 break-words">
                        {change.key}：{change.before} → {change.after}
                      </p>
                    ))}
                  </details>
                </Field>
              ))}
            </FieldGroup>
            <p className="text-sm text-muted-foreground">
              覆盖所选默认值及权限规则；运行环境需重启后台后生效。
            </p>
            <div className="flex gap-2">
              <Button
                disabled={busy || !importGroups.length}
                onClick={() =>
                  void run(async () => {
                    await window.desktop.configurationSettings.applyImport({
                      id: preview.id,
                      categories: importGroups,
                    })
                    setPreview(null)
                    onImported?.()
                    setNotice("已导入，请重新读取设置；运行环境需重启后台。")
                  })
                }
              >
                应用所选配置
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                取消导入
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
