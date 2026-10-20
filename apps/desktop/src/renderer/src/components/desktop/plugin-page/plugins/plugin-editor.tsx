import { useRef, useState } from "react"
import { FileJson, Upload } from "lucide-react"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { parsePluginConfig, type PluginConfig } from "./plugin-config"

type EditableConfig = Omit<PluginConfig, "id" | "enabled">
const emptyConfig: EditableConfig = { name: "", description: "", source: "", version: "1.0.0" }

export function PluginEditor({
  initial,
  onClose,
  onSave,
}: {
  initial?: EditableConfig
  onClose: () => void
  onSave: (config: EditableConfig) => void
}): React.JSX.Element {
  const [form, setForm] = useState(initial ?? emptyConfig)
  const [mode, setMode] = useState("form")
  const [json, setJson] = useState(JSON.stringify(initial ?? emptyConfig, null, 2))
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  function switchMode(next: string): void {
    try {
      if (next === "form") setForm(parsePluginConfig(json))
      else setJson(JSON.stringify(form, null, 2))
      setError("")
      setMode(next)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }
  function submit(): void {
    try {
      onSave(parsePluginConfig(mode === "json" ? json : JSON.stringify(form)))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            if (dirty) setDiscard(true)
            else onClose()
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto p-6 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{initial ? "编辑插件配置" : "添加插件配置"}</DialogTitle>
            <DialogDescription>
              保存插件信息与来源，以便后续完成安装。配置仅保存在当前项目的本机记录中。
            </DialogDescription>
          </DialogHeader>
          <ToggleGroup
            value={[mode]}
            onValueChange={(value) => value[0] && switchMode(value[0])}
            aria-label="插件录入方式"
          >
            <ToggleGroupItem value="form">表单</ToggleGroupItem>
            <ToggleGroupItem value="json">JSON</ToggleGroupItem>
          </ToggleGroup>
          <form
            id="plugin-config-form"
            className="py-2"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            {mode === "form" ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="plugin-name">名称</FieldLabel>
                  <Input
                    id="plugin-name"
                    required
                    value={form.name}
                    placeholder="插件名称"
                    onChange={(event) => {
                      setDirty(true)
                      setForm({ ...form, name: event.target.value })
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="plugin-description">描述</FieldLabel>
                  <Textarea
                    id="plugin-description"
                    value={form.description}
                    placeholder="这个插件可以帮助你做什么？"
                    onChange={(event) => {
                      setDirty(true)
                      setForm({ ...form, description: event.target.value })
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="plugin-source">来源地址或本地目录</FieldLabel>
                  <Input
                    id="plugin-source"
                    value={form.source}
                    placeholder="仓库地址或插件所在目录（可稍后填写）"
                    onChange={(event) => {
                      setDirty(true)
                      setForm({ ...form, source: event.target.value })
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="plugin-version">版本</FieldLabel>
                  <Input
                    id="plugin-version"
                    value={form.version}
                    placeholder="1.0.0"
                    onChange={(event) => {
                      setDirty(true)
                      setForm({ ...form, version: event.target.value })
                    }}
                  />
                </Field>
              </FieldGroup>
            ) : (
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="plugin-json">JSON 配置</FieldLabel>
                <Textarea
                  id="plugin-json"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  className="min-h-64 font-mono text-xs leading-6"
                  value={json}
                  onChange={(event) => {
                    setDirty(true)
                    setJson(event.target.value)
                    setError("")
                  }}
                />
              </Field>
            )}
          </form>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".json,application/json"
            aria-label="导入插件 JSON"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (!file) return
              try {
                if (file.size > 1_048_576) throw new Error("配置文件不能超过 1 MB。")
                const value = await file.text()
                const parsed = parsePluginConfig(value)
                setForm(parsed)
                setJson(JSON.stringify(parsed, null, 2))
                setMode("json")
                setDirty(true)
                setError("")
              } catch (cause) {
                setError((cause as Error).message)
              }
            }}
          />
          <DialogFooter className="mt-2 sm:justify-between">
            <Button variant="ghost" onClick={() => fileInput.current?.click()}>
              <Upload data-icon="inline-start" />
              导入 JSON
            </Button>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => (dirty ? setDiscard(true) : onClose())}>
                取消
              </Button>
              <Button type="submit" form="plugin-config-form">
                <FileJson data-icon="inline-start" />
                保存配置
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>关闭后，本次编辑的内容不会保存。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
