import { useId, useRef, useState } from "react"
import { Braces, List } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@renderer/components/ui/field"
import { Textarea } from "@renderer/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { Separator } from "@renderer/components/ui/separator"
import {
  fromMcpForm,
  mcpTransport,
  parseMcpJson,
  serializeMcpDocument,
  toMcpForm,
  type McpDocument,
  type McpForm,
} from "./mcp-config"
import { McpFormFields } from "./mcp-form"

export function McpEditor({
  initial,
  editingName,
  existingNames,
  onSave,
  onClose,
}: {
  initial: McpDocument
  /** Stable name of the server being edited; renames are rejected. */
  editingName?: string
  existingNames: string[]
  onSave: (document: McpDocument) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const id = useId()
  const editing = editingName !== undefined
  const [mode, setMode] = useState(() =>
    initial.servers.some((server) => mcpTransport(server.config) === "sse") ? "json" : "form"
  )
  const [json, setJson] = useState(() => serializeMcpDocument(initial))
  const [document, setDocument] = useState(initial)
  const [forms, setForms] = useState<McpForm[]>(() => initial.servers.map(toMcpForm))
  const [activeIndex, setActiveIndex] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)

  function report(message: string): void {
    setError(message)
    requestAnimationFrame(() => errorRef.current?.focus())
  }
  function currentDocument(): McpDocument {
    return mode === "json"
      ? parseMcpJson(json, { allowIncomplete: true })
      : { ...document, servers: forms.map(fromMcpForm) }
  }
  function changeMode(next: string): void {
    if (!next || next === mode) return
    try {
      const nextDocument = currentDocument()
      if (next === "form") {
        setDocument(nextDocument)
        setForms(nextDocument.servers.map(toMcpForm))
        setActiveIndex(0)
      } else {
        setJson(serializeMcpDocument(nextDocument))
      }
      setMode(next)
      setError("")
    } catch (e) {
      report(e instanceof Error ? e.message : "配置无法转换，请检查输入")
    }
  }
  async function save(): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      const value = parseMcpJson(serializeMcpDocument(currentDocument()), {
        existingNames,
        ...(editingName !== undefined ? { editingName } : {}),
      })
      if (editing && value.servers.length !== 1)
        throw new Error("编辑时只能保存一个服务器；批量导入请使用添加 MCP")
      await onSave(value)
      onClose()
    } catch (e) {
      report(e instanceof Error ? e.message : "保存失败，请检查配置")
    } finally {
      setSaving(false)
    }
  }
  function close(): void {
    if (saving) return
    if (dirty) setDiscard(true)
    else onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pr-12 pb-4">
          <DialogTitle>{editing ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</DialogTitle>
          <DialogDescription>
            保存到全局 settings.mcpServers，与 CLI 共用；停用或删除会同步到已有会话。
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 px-6 pb-4">
          <ToggleGroup
            aria-label="配置编辑方式"
            value={[mode]}
            onValueChange={(v) => changeMode(v[0])}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="json">
              <Braces aria-hidden="true" />
              JSON
            </ToggleGroupItem>
            <ToggleGroupItem value="form">
              <List aria-hidden="true" />
              表单
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Separator />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {mode === "json" ? (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={`${id}-json`}>服务器配置 JSON</FieldLabel>
              <Textarea
                id={`${id}-json`}
                value={json}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : `${id}-hint`}
                spellCheck={false}
                className="[field-sizing:fixed] min-h-64 resize-y font-mono text-xs leading-6"
                onChange={(e) => {
                  setJson(e.target.value)
                  setDirty(true)
                  setError("")
                }}
              />
              <FieldDescription id={`${id}-hint`}>
                支持含 name 的单个对象，或 {'{ "mcpServers": { "名称": { … } } }'}{" "}
                批量配置。扩展字段会原样保留。
              </FieldDescription>
            </Field>
          ) : (
            <div className="flex flex-col gap-5">
              {forms.length > 1 && (
                <Field>
                  <FieldLabel id={`${id}-batch`}>待添加的服务器（{forms.length}）</FieldLabel>
                  <ToggleGroup
                    aria-labelledby={`${id}-batch`}
                    className="max-w-full flex-wrap"
                    value={[String(activeIndex)]}
                    onValueChange={(v) => {
                      if (v[0]) setActiveIndex(Number(v[0]))
                    }}
                    size="sm"
                  >
                    {forms.map((entry, index) => (
                      <ToggleGroupItem key={index} value={String(index)}>
                        {entry.name || `服务器 ${index + 1}`}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              )}
              {forms[activeIndex] && (
                <McpFormFields
                  value={forms[activeIndex]}
                  error={error}
                  errorId={`${id}-error`}
                  nameLocked={editing}
                  onChange={(value) => {
                    setForms(forms.map((form, index) => (index === activeIndex ? value : form)))
                    setDirty(true)
                    setError("")
                  }}
                />
              )}
            </div>
          )}
        </div>
        <Separator />
        <div className="shrink-0 px-6 py-4">
          {error && (
            <FieldError
              id={`${id}-error`}
              ref={errorRef}
              tabIndex={-1}
              className="mb-3 max-h-24 overflow-y-auto break-words"
            >
              {error}
            </FieldError>
          )}
          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            <span className="text-xs text-muted-foreground">
              保存到全局配置，与 CLI 共用
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={close} disabled={saving}>
                取消
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full px-3"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </DialogFooter>
        </div>
        <AlertDialog open={discard} onOpenChange={setDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
              <AlertDialogDescription>
                关闭后，当前编辑内容将丢失。已保存的配置不会受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>继续编辑</AlertDialogCancel>
              <Button variant="destructive" onClick={onClose}>
                放弃更改
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
