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
import { Field, FieldError, FieldLabel } from "@renderer/components/ui/field"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { Textarea } from "@renderer/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import type {
  DesktopMcpAuthMode,
  DesktopMcpAuthStatus,
  DesktopMcpOperationResult,
  DesktopMcpRuntimeStatus,
  DesktopMcpServer,
  DesktopMcpSnapshot,
} from "@shared/mcp-types"
import type { McpConfig, McpDocument } from "./mcp-config"
import { McpEditor } from "./mcp-editor"

export interface McpManagerProps {
  query: string
  addRequest: number
  refreshRequest: number
  notify: (message: string) => void
}

type Editor = {
  initial: McpDocument
  editingName?: string
  expectedConfig?: McpConfig
}

const authModeLabels: Record<DesktopMcpAuthMode, string> = {
  none: "无需认证",
  oauth: "OAuth",
  bearer: "Bearer",
  custom: "自定义",
}
const authStatusLabels: Record<DesktopMcpAuthStatus, string> = {
  "not-configured": "未配置",
  "not-logged-in": "未登录",
  valid: "已授权",
  "expired-refreshable": "凭据可刷新",
  "reauthentication-required": "需要重新授权",
  static: "静态凭据",
  unsupported: "不支持",
}
const runtimeStatusLabels: Record<DesktopMcpRuntimeStatus, string> = {
  connected: "已连接",
  disconnected: "未连接",
  error: "连接失败",
  unavailable: "无活动会话",
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "操作失败，请重试"
}

function newDocument(): McpDocument {
  return {
    servers: [{ name: "", config: { type: "stdio", command: "" } }],
    extras: {},
    wrapped: false,
  }
}

function serverDocument(server: DesktopMcpServer, config: McpConfig): McpDocument {
  return { servers: [{ name: server.name, config }], extras: {}, wrapped: false }
}

/** The single most relevant status for one list row. */
function statusLabel(server: DesktopMcpServer): string {
  if (!server.enabled) return "已停用"
  if (server.authStatus === "reauthentication-required") return "需要重新授权"
  if (server.authStatus === "not-logged-in") return "未登录"
  if (server.runtimeStatus === "error") return "连接失败"
  if (server.runtimeStatus === "connected") return "已连接"
  if (server.runtimeStatus === "disconnected") return "未连接"
  return "无活动会话"
}

function canAuthorize(server: DesktopMcpServer): boolean {
  return server.transport === "http" && server.authMode === "oauth"
}

export function McpManager({ query, addRequest, refreshRequest, notify }: McpManagerProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopMcpSnapshot | null>(null)
  const [loadError, setLoadError] = useState("")
  const [operationError, setOperationError] = useState("")
  const [filter, setFilter] = useState("all")
  const [editor, setEditor] = useState<Editor | null>(null)
  const [detailName, setDetailName] = useState<string | null>(null)
  const [detailJson, setDetailJson] = useState("")
  const [removeName, setRemoveName] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState("")
  const [exportOpen, setExportOpen] = useState(false)
  const [exportJson, setExportJson] = useState("")
  const [exportError, setExportError] = useState("")
  const [busyName, setBusyName] = useState<string | null>(null)
  const seenAdd = useRef(addRequest)
  const seenRefresh = useRef(refreshRequest)

  const servers = snapshot?.servers ?? []

  async function load(): Promise<DesktopMcpSnapshot | null> {
    try {
      const next = await window.desktop.mcp.snapshot()
      setSnapshot(next)
      setLoadError("")
      return next
    } catch (error) {
      setLoadError(errorMessage(error))
      return null
    }
  }

  useEffect(() => {
    void load()
    // Load once on mount; refreshes go through refreshRequest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (addRequest <= seenAdd.current) {
      seenAdd.current = addRequest
      return
    }
    seenAdd.current = addRequest
    setDetailName(null)
    setEditor((current) => current ?? { initial: newDocument() })
  }, [addRequest])

  useEffect(() => {
    if (refreshRequest === seenRefresh.current) return
    seenRefresh.current = refreshRequest
    setOperationError("")
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRequest])

  function reportResult(result: DesktopMcpOperationResult, action: string, name: string): void {
    if (!result.persisted) {
      notify(`服务配置仍在，但已退出登录：${name}`)
      return
    }
    if (result.runtimeFailures.length) {
      notify(`已保存 ${name}，但同步到活动会话失败；将在新会话中生效`)
      return
    }
    if (result.credentialRemoved) {
      notify(`已${action} ${name}；需要重新授权`)
      return
    }
    notify(`已${action} ${name}`)
  }

  async function saveEditor(incoming: McpDocument): Promise<void> {
    const entry = incoming.servers[0]
    if (!entry) throw new Error("请填写服务器配置")
    const config = entry.config as Record<string, unknown>
    const result = editor?.editingName
      ? await window.desktop.mcp.update({
          name: editor.editingName,
          config,
          expectedConfig: (editor.expectedConfig ?? {}) as Record<string, unknown>,
        })
      : await window.desktop.mcp.add({ name: entry.name, config })
    setSnapshot(result.snapshot)
    reportResult(result, editor?.editingName ? "更新" : "添加", entry.name)
  }

  async function openEditor(server: DesktopMcpServer): Promise<void> {
    setDetailName(null)
    setOperationError("")
    try {
      const config = (await window.desktop.mcp.getConfig({ name: server.name })) as McpConfig
      setEditor({ initial: serverDocument(server, config), editingName: server.name, expectedConfig: config })
    } catch (error) {
      setOperationError(errorMessage(error))
      notify(errorMessage(error))
    }
  }

  async function openDetail(server: DesktopMcpServer): Promise<void> {
    setDetailName(server.name)
    setDetailJson("")
    try {
      const config = await window.desktop.mcp.getConfig({ name: server.name })
      setDetailJson(JSON.stringify(config, null, 2))
    } catch {
      // Status still renders; the full JSON stays hidden.
    }
  }

  async function toggle(server: DesktopMcpServer, enabled: boolean): Promise<void> {
    setBusyName(server.name)
    try {
      const result = await window.desktop.mcp.setEnabled({ name: server.name, enabled })
      setSnapshot(result.snapshot)
      reportResult(result, enabled ? "启用" : "停用", server.name)
    } catch (error) {
      setOperationError(errorMessage(error))
      notify(errorMessage(error))
    } finally {
      setBusyName(null)
    }
  }

  async function remove(): Promise<void> {
    if (!removeName) return
    const name = removeName
    setBusyName(name)
    try {
      const result = await window.desktop.mcp.remove({ name })
      setSnapshot(result.snapshot)
      setRemoveName(null)
      setDetailName(null)
      if (!result.persisted) notify(`服务配置仍在，但已退出登录：${name}`)
      else notify(`已移除 ${name}`)
    } catch (error) {
      setRemoveError(errorMessage(error))
    } finally {
      setBusyName(null)
    }
  }

  async function login(server: DesktopMcpServer): Promise<void> {
    setBusyName(server.name)
    try {
      const next = await window.desktop.mcp.login({ name: server.name, scopes: [] })
      setSnapshot(next)
      notify(`${server.name} 授权已保存`)
    } catch (error) {
      const refreshed = await load()
      const current = refreshed?.servers.find((item) => item.name === server.name)
      if (current?.authStatus === "valid" || current?.authStatus === "expired-refreshable") {
        notify(`授权已保存，但重连失败：${server.name}`)
      } else {
        setOperationError(errorMessage(error))
        notify(errorMessage(error))
      }
    } finally {
      setBusyName(null)
    }
  }

  async function logout(server: DesktopMcpServer): Promise<void> {
    setBusyName(server.name)
    try {
      const next = await window.desktop.mcp.logout({ name: server.name })
      setSnapshot(next)
      notify(`${server.name} 已退出登录`)
    } catch (error) {
      const refreshed = await load()
      const current = refreshed?.servers.find((item) => item.name === server.name)
      if (current?.authStatus === "not-logged-in") {
        notify(`已退出登录，但断开活动会话失败：${server.name}`)
      } else {
        setOperationError(errorMessage(error))
        notify(errorMessage(error))
      }
    } finally {
      setBusyName(null)
    }
  }

  async function openExport(): Promise<void> {
    setExportError("")
    try {
      const result = await window.desktop.mcp.exportConfig()
      setExportJson(JSON.stringify({ mcpServers: result.mcpServers }, null, 2))
      setExportOpen(true)
    } catch (error) {
      setOperationError(errorMessage(error))
      notify(errorMessage(error))
    }
  }

  function download(): void {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([exportJson], { type: "application/json" }))
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
    } catch (error) {
      setExportError(`无法下载：${errorMessage(error)}。可选中上方 JSON 手动复制。`)
    } finally {
      if (url) {
        const objectUrl = url
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      }
    }
  }

  const needle = query.trim().toLocaleLowerCase()
  const visible = servers.filter((server) => {
    const matchesFilter =
      filter === "all" || (filter === "enabled" ? server.enabled : !server.enabled)
    const matchesQuery =
      !needle ||
      `${server.name} ${server.summary} ${server.transport}`.toLocaleLowerCase().includes(needle)
    return matchesFilter && matchesQuery
  })
  const detail = servers.find((server) => server.name === detailName)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {servers.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            aria-label="MCP 状态筛选"
            value={[filter]}
            onValueChange={(value) => {
              if (value[0]) setFilter(value[0])
            }}
            size="sm"
          >
            <ToggleGroupItem value="all">全部</ToggleGroupItem>
            <ToggleGroupItem value="enabled">已启用</ToggleGroupItem>
            <ToggleGroupItem value="disabled">已停用</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="ghost" size="sm" disabled={Boolean(loadError)} onClick={() => void openExport()}>
            <Download data-icon="inline-start" />
            导出 JSON
          </Button>
        </div>
      ) : null}
      {(loadError || operationError) && (
        <Alert variant="destructive">
          <AlertTitle>MCP 状态未更新</AlertTitle>
          <AlertDescription>{loadError || operationError}</AlertDescription>
        </Alert>
      )}
      {visible.length ? (
        <ul aria-label="已保存的 MCP 服务器">
          {visible.map((server, index) => {
            const Icon = server.transport === "stdio" ? Terminal : Globe
            const busy = busyName === server.name
            return (
              <Fragment key={server.name}>
                {index > 0 && (
                  <li aria-hidden="true">
                    <Separator />
                  </li>
                )}
                <li
                  data-extension-row
                  data-enabled={server.enabled}
                  className={`flex min-h-18 items-center gap-3 py-3 ${server.enabled ? "" : "opacity-60"}`}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`查看 ${server.name} 的 MCP 配置`}
                    onClick={() => void openDetail(server)}
                  >
                    <span className="block truncate text-sm font-medium">{server.name}</span>
                    <span className="block truncate text-xs leading-5 text-muted-foreground">
                      {server.summary || "—"}
                    </span>
                    <span className="block text-xs text-muted-foreground sm:hidden">
                      {server.transport.toUpperCase()} · {statusLabel(server)}
                    </span>
                  </button>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {server.transport.toUpperCase()} · {statusLabel(server)}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      size="sm"
                      aria-label={`${server.enabled ? "停用" : "启用"} ${server.name}`}
                      checked={server.enabled}
                      disabled={busy || Boolean(loadError)}
                      onCheckedChange={(checked) => void toggle(server, checked)}
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
              {servers.length
                ? "没有符合条件的服务器"
                : loadError
                  ? "暂时无法显示 MCP 配置"
                  : "还没有 MCP"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {editor && (
        <McpEditor
          initial={editor.initial}
          editingName={editor.editingName}
          existingNames={servers.filter((item) => item.name !== editor.editingName).map((item) => item.name)}
          onSave={saveEditor}
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
              {detail
                ? `${detail.enabled ? "已启用" : "已停用"} · ${statusLabel(detail)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">传输方式</dt>
                <dd>{detail.transport.toUpperCase()}</dd>
                <dt className="text-muted-foreground">
                  {detail.transport === "stdio" ? "启动命令" : "地址"}
                </dt>
                <dd className="break-all">{detail.summary || "—"}</dd>
                <dt className="text-muted-foreground">启用状态</dt>
                <dd>{detail.enabled ? "已启用" : "已停用"}</dd>
                <dt className="text-muted-foreground">认证方式</dt>
                <dd>{authModeLabels[detail.authMode]}</dd>
                <dt className="text-muted-foreground">认证状态</dt>
                <dd>{authStatusLabels[detail.authStatus]}</dd>
                <dt className="text-muted-foreground">Runtime 状态</dt>
                <dd>{runtimeStatusLabels[detail.runtimeStatus]}</dd>
                <dt className="text-muted-foreground">已配置 scopes</dt>
                <dd>{detail.scopes.join(", ") || "（无）"}</dd>
              </dl>

              {canAuthorize(detail) ? (
                <div className="flex flex-wrap items-center gap-2">
                  {detail.authStatus === "valid" || detail.authStatus === "expired-refreshable" ? (
                    <Button
                      variant="outline"
                      disabled={busyName === detail.name}
                      onClick={() => void logout(detail)}
                    >
                      退出登录
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busyName === detail.name}
                      onClick={() => void login(detail)}
                    >
                      {detail.authStatus === "reauthentication-required" ? "重新授权" : "浏览器授权"}
                    </Button>
                  )}
                </div>
              ) : detail.authMode === "none" ? (
                <p className="text-xs text-muted-foreground">该服务无需认证。</p>
              ) : null}

              {detailJson && (
                <details className="text-sm">
                  <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    查看完整配置 JSON（可能包含环境变量值或请求头）
                  </summary>
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                    {detailJson}
                  </pre>
                </details>
              )}
            </div>
          )}
          <Separator />
          <DialogFooter className="shrink-0 flex-row justify-between sm:justify-between">
            <Button
              variant="destructive"
              disabled={busyName === detail?.name}
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
              disabled={busyName === detail?.name}
              onClick={() => {
                if (detail) void openEditor(detail)
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
                <AlertDialogTitle>移除 MCP 服务？</AlertDialogTitle>
                <AlertDialogDescription>
                  将从全局配置移除「{removeName}」，并清理其本地 OAuth 凭据；已有会话会同步断开。
                </AlertDialogDescription>
              </AlertDialogHeader>
              {removeError && <FieldError>{removeError}</FieldError>}
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <Button variant="destructive" onClick={() => void remove()}>
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
              包含全局 {servers.length} 个 MCP 服务的真实配置及启用状态。JSON
              可能包含环境变量值或请求头，请妥善保管；OAuth 令牌不会出现在这里。
            </DialogDescription>
          </DialogHeader>
          <Field className="min-h-0 overflow-y-auto">
            <FieldLabel htmlFor="mcp-export-json">导出 JSON</FieldLabel>
            <Textarea
              id="mcp-export-json"
              readOnly
              value={exportJson}
              className="[field-sizing:fixed] min-h-48 font-mono text-xs leading-5"
              spellCheck={false}
              onFocus={(event) => event.target.select()}
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
