import { Fragment, useEffect, useRef, useState } from "react"
import { Download, Globe, Pencil, Terminal, Trash2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import {
  AlertDialog,
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
import { Empty, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty"
import { FieldError, FieldLabel, Field } from "@renderer/components/ui/field"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { Textarea } from "@renderer/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import {
  emptyMcpDocument,
  loadMcpStorage,
  mcpTransport,
  parseMcpJson,
  saveMcpStorage,
  serializeMcpDocument,
  type McpDocument,
  type McpEntry,
} from "./mcp-config"
import { McpEditor } from "./mcp-editor"

export interface McpManagerProps {
  query: string
  addRequest: number
  refreshRequest: number
  projectPath: string
  notify: (message: string) => void
}

type Snapshot = { document: McpDocument; raw: string | null; error: string }
type Editor = { initial: McpDocument; originalName?: string; baseRaw: string | null }

function newEditor(baseRaw: string | null, type: "stdio" | "http" = "stdio"): Editor {
  return {
    initial: {
      servers: [
        {
          name: "",
          config: type === "stdio" ? { type, command: "", args: [] } : { type, url: "" },
        },
      ],
      extras: {},
      wrapped: false,
    },
    baseRaw,
  }
}

function read(projectPath: string): Snapshot {
  try {
    return { ...loadMcpStorage(window.localStorage, projectPath), error: "" }
  } catch (e) {
    return {
      document: emptyMcpDocument(),
      raw: null,
      error: `无法读取本机配置：${errorMessage(e)}。原始数据未被修改，请检查浏览器存储后刷新。`,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试"
}
function singleDocument(entry: McpEntry): McpDocument {
  // Keep extension fields such as "name" and "mcpServers" inside the server config.
  return { servers: [entry], extras: {}, wrapped: true }
}
function endpoint(entry: McpEntry): string {
  if (mcpTransport(entry.config) === "stdio") return String(entry.config.command ?? "")
  try {
    const url = new URL(String(entry.config.url))
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return "HTTP 服务器"
  }
}

/** Project-scoped, frontend-only MCP configuration. No process or network calls. */
export function McpManager(props: McpManagerProps): React.JSX.Element {
  return <McpProjectManager key={props.projectPath} {...props} />
}

function McpProjectManager({
  query,
  addRequest,
  refreshRequest,
  projectPath,
  notify,
}: McpManagerProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => read(projectPath))
  const [filter, setFilter] = useState("all")
  const [editor, setEditor] = useState<Editor | null>(null)
  const [detailName, setDetailName] = useState<string | null>(null)
  const [removeName, setRemoveName] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState("")
  const [exportOpen, setExportOpen] = useState(false)
  const [exportError, setExportError] = useState("")
  const [operationError, setOperationError] = useState("")
  const seenAdd = useRef(addRequest)
  const seenRefresh = useRef(refreshRequest)
  const document = snapshot.document

  useEffect(() => {
    if (addRequest <= seenAdd.current) {
      seenAdd.current = addRequest
      return
    }
    seenAdd.current = addRequest
    setDetailName(null)
    setEditor((current) => current ?? newEditor(snapshot.raw))
  }, [addRequest, snapshot.raw])

  useEffect(() => {
    if (refreshRequest === seenRefresh.current) return
    seenRefresh.current = refreshRequest
    const next = read(projectPath)
    setSnapshot(next)
    setOperationError("")
    notify(next.error || "已重新读取本机 MCP 配置；服务器尚未连接")
  }, [refreshRequest, projectPath, notify])

  function persist(next: McpDocument, expectedRaw = snapshot.raw): string | null {
    try {
      if (snapshot.error) throw new Error(snapshot.error)
      const raw = saveMcpStorage(window.localStorage, projectPath, next, expectedRaw)
      setSnapshot({ document: next, raw, error: "" })
      setOperationError("")
      return null
    } catch (e) {
      return errorMessage(e)
    }
  }

  function saveEditor(incoming: McpDocument): string | null {
    if (!editor) return "编辑器已关闭，请重新打开"
    if (editor.baseRaw !== snapshot.raw)
      return "编辑期间本机配置已变化。请复制当前 JSON，关闭并重新打开编辑器后重试。"
    try {
      const remaining = document.servers.filter((s) => s.name !== editor.originalName)
      parseMcpJson(serializeMcpDocument(incoming), { existingNames: remaining.map((s) => s.name) })
      const servers =
        editor.originalName === undefined
          ? [...document.servers, ...incoming.servers]
          : document.servers.map((s) => (s.name === editor.originalName ? incoming.servers[0] : s))
      const error = persist(
        { servers, extras: { ...document.extras, ...incoming.extras }, wrapped: true },
        editor.baseRaw
      )
      if (!error)
        notify(
          editor.originalName === undefined
            ? `已在本机保存 ${incoming.servers.length} 个 MCP 配置；尚未连接`
            : "MCP 配置已在本机更新；尚未连接"
        )
      return error
    } catch (e) {
      return errorMessage(e)
    }
  }

  function toggle(entry: McpEntry, enabled: boolean): void {
    const next = {
      ...document,
      servers: document.servers.map((s) =>
        s.name === entry.name ? { ...s, config: { ...s.config, enabled } } : s
      ),
    }
    const error = persist(next)
    if (error) {
      setOperationError(error)
      notify(error)
    } else notify(`${entry.name} 已${enabled ? "启用" : "停用"}（仅本机配置，未连接）`)
  }

  function edit(entry: McpEntry): void {
    setDetailName(null)
    setEditor({ initial: singleDocument(entry), originalName: entry.name, baseRaw: snapshot.raw })
  }

  function remove(): void {
    const error = persist({
      ...document,
      servers: document.servers.filter((s) => s.name !== removeName),
    })
    if (error) {
      setRemoveError(error)
      return
    }
    notify(`${removeName} 的本机配置已移除`)
    setRemoveName(null)
    setDetailName(null)
  }

  function download(): void {
    let url: string | undefined
    try {
      url = URL.createObjectURL(
        new Blob([serializeMcpDocument({ ...document, wrapped: true })], {
          type: "application/json",
        })
      )
      const link = window.document.createElement("a")
      link.href = url
      link.download = "mcp-servers.json"
      window.document.body.append(link)
      try {
        link.click()
      } finally {
        link.remove()
      }
      notify("已发起 JSON 下载")
    } catch (e) {
      setExportError(`无法下载：${errorMessage(e)}。可选中上方 JSON 手动复制。`)
    } finally {
      if (url) {
        const objectUrl = url
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      }
    }
  }

  const needle = query.trim().toLocaleLowerCase()
  const visible = document.servers.filter((entry) => {
    const enabled = entry.config.enabled !== false
    return (
      (filter === "all" || (filter === "enabled" ? enabled : !enabled)) &&
      (!needle ||
        `${entry.name} ${endpoint(entry)} ${mcpTransport(entry.config)}`
          .toLocaleLowerCase()
          .includes(needle))
    )
  })
  const detail = document.servers.find((entry) => entry.name === detailName)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {document.servers.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            aria-label="MCP 状态筛选"
            value={[filter]}
            onValueChange={(v) => {
              if (v[0]) setFilter(v[0])
            }}
            size="sm"
          >
            <ToggleGroupItem value="all">全部</ToggleGroupItem>
            <ToggleGroupItem value="enabled">已启用</ToggleGroupItem>
            <ToggleGroupItem value="disabled">已停用</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="sm"
            disabled={!document.servers.length || Boolean(snapshot.error)}
            onClick={() => {
              setExportError("")
              setExportOpen(true)
            }}
          >
            <Download data-icon="inline-start" />
            导出 JSON
          </Button>
        </div>
      ) : null}
      {(snapshot.error || operationError) && (
        <Alert variant="destructive">
          <AlertTitle>本机配置未更新</AlertTitle>
          <AlertDescription>{snapshot.error || operationError}</AlertDescription>
        </Alert>
      )}
      {visible.length ? (
        <ul aria-label="已保存的 MCP 服务器">
          {visible.map((entry, index) => {
            const transport = mcpTransport(entry.config)
            const Icon = transport === "http" ? Globe : Terminal
            return (
              <Fragment key={entry.name}>
                {index > 0 && (
                  <li aria-hidden="true">
                    <Separator />
                  </li>
                )}
                <li data-extension-row className="flex min-h-18 items-center gap-3 py-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`查看 ${entry.name} 的 MCP 配置`}
                    onClick={() => setDetailName(entry.name)}
                  >
                    <span className="block truncate text-sm font-medium">{entry.name}</span>
                    <span className="block truncate text-xs leading-5 text-muted-foreground">
                      {endpoint(entry)}
                    </span>
                    <span className="block text-xs text-muted-foreground sm:hidden">
                      {transport.toUpperCase()} · 未连接
                    </span>
                  </button>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {transport.toUpperCase()} · 未连接
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      size="sm"
                      aria-label={`启用 ${entry.name}（仅本机配置）`}
                      checked={entry.config.enabled !== false}
                      disabled={Boolean(snapshot.error)}
                      onCheckedChange={(checked) => toggle(entry, checked)}
                    />
                  </div>
                </li>
              </Fragment>
            )
          })}
        </ul>
      ) : (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyTitle>
              {document.servers.length
                ? "没有符合条件的服务器"
                : snapshot.error
                  ? "暂时无法显示 MCP 配置"
                  : "还没有 MCP"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {editor && (
        <McpEditor
          initial={editor.initial}
          editingName={editor.originalName}
          existingNames={document.servers
            .filter((s) => s.name !== editor.originalName)
            .map((s) => s.name)}
          onSave={async (incoming) => {
            const saveError = saveEditor(incoming)
            if (saveError) throw new Error(saveError)
          }}
          onClose={() => {
            setEditor(null)
          }}
        />
      )}

      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetailName(null)
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-5 sm:max-w-xl">
          <DialogHeader className="pr-8">
            <DialogTitle className="break-all">{detail?.name}</DialogTitle>
            <DialogDescription>
              仅保存在本机 · {detail?.config.enabled === false ? "已停用" : "已启用"} · 未连接
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">类型</dt>
                <dd>{mcpTransport(detail.config).toUpperCase()}</dd>
                <dt className="text-muted-foreground">
                  {mcpTransport(detail.config) === "stdio" ? "启动命令" : "地址"}
                </dt>
                <dd className="break-all">{endpoint(detail)}</dd>
                <dt className="text-muted-foreground">保存范围</dt>
                <dd className="break-all">{projectPath || "本机默认范围"}</dd>
              </dl>
              <details className="text-sm">
                <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  查看完整 JSON（可能包含敏感值）
                </summary>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                  {serializeMcpDocument(singleDocument(detail))}
                </pre>
              </details>
            </div>
          )}
          <Separator />
          <DialogFooter className="shrink-0 flex-row justify-between sm:justify-between">
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveError("")
                setRemoveName(detailName)
              }}
            >
              <Trash2 data-icon="inline-start" />
              移除
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (detail) edit(detail)
              }}
            >
              <Pencil data-icon="inline-start" />
              编辑配置
            </Button>
          </DialogFooter>
          <AlertDialog
            open={removeName !== null}
            onOpenChange={(open) => {
              if (!open) setRemoveName(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>移除 MCP 配置？</AlertDialogTitle>
                <AlertDialogDescription>
                  将移除「{removeName}」在当前项目中的本机配置。移除后可通过 JSON 重新添加。
                </AlertDialogDescription>
              </AlertDialogHeader>
              {removeError && <FieldError>{removeError}</FieldError>}
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <Button variant="destructive" onClick={remove}>
                  移除配置
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader className="pr-8">
            <DialogTitle>导出 MCP 配置</DialogTitle>
            <DialogDescription>
              包含当前项目全部 {document.servers.length} 个已保存配置及启用状态。JSON
              可能包含环境变量值或请求头密钥，请妥善保管。
            </DialogDescription>
          </DialogHeader>
          <Field className="min-h-0 overflow-y-auto">
            <FieldLabel htmlFor="mcp-export-json">导出 JSON</FieldLabel>
            <Textarea
              id="mcp-export-json"
              readOnly
              value={serializeMcpDocument({ ...document, wrapped: true })}
              className="[field-sizing:fixed] min-h-48 font-mono text-xs leading-5"
              spellCheck={false}
              onFocus={(e) => e.target.select()}
            />
          </Field>
          {exportError && <FieldError>{exportError}</FieldError>}
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              关闭
            </Button>
            <Button onClick={download}>
              <Download data-icon="inline-start" />
              下载 JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
