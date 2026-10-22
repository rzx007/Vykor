import { groupPermissions } from "./plugin-permissions"
import { useEffect, useRef, useState } from "react"
import type { MarketplaceCatalog, MarketplaceEntry, MarketplaceOperation } from "@vykor/client"
import type { DesktopMarketplacePreview, DesktopPluginInfo } from "@shared/plugin-types"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Switch } from "@renderer/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@renderer/components/ui/dialog"
import { pluginErrorMessage } from "@renderer/lib/plugin-error"

const capabilityLabels: Record<string, string> = {
  tool: "工具",
  tools: "工具",
  mcp: "工具服务",
  app: "常驻应用",
  apps: "常驻应用",
  skill: "技能",
  skills: "技能",
  agent: "智能体",
  agents: "智能体",
  hook: "运行钩子",
  hooks: "运行钩子",
  command: "快捷命令",
  commands: "快捷命令",
}
const capabilities = (types: string[]): string =>
  types.map((type) => capabilityLabels[type] ?? type).join("、")

export function Marketplace({
  query,
  projectPath,
  refreshRequest,
  sourceAddRequest = 0,
  notify,
  onUse,
}: {
  query: string
  projectPath: string
  refreshRequest: number
  sourceAddRequest?: number
  notify: (message: string) => void
  onUse?: (plugin: DesktopPluginInfo, prompt: string) => Promise<void>
}): React.JSX.Element {
  const api = window.desktop?.plugins
  const [catalog, setCatalog] = useState<MarketplaceCatalog>({ entries: [], sources: [] })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [selected, setSelected] = useState<MarketplaceEntry | null>(null)
  const [approval, setApproval] = useState<DesktopMarketplacePreview | null>(null)
  const [operation, setOperation] = useState<MarketplaceOperation | null>(null)
  const [installed, setInstalled] = useState<DesktopPluginInfo | null>(null)
  const generation = useRef(0)
  const handle = useRef<string | null>(null)
  const lock = useRef(false)
  const previousRefresh = useRef(refreshRequest)
  const previousAdd = useRef(sourceAddRequest)
  async function load(refresh = false): Promise<void> {
    if (!api?.marketplaceCatalog) {
      setLoading(false)
      return
    }
    const current = generation.current
    try {
      const result = await api.marketplaceCatalog({ cwd: projectPath, refresh })
      if (current === generation.current) {
        setCatalog(result)
        setError("")
      }
    } catch (cause) {
      if (current === generation.current) setError(pluginErrorMessage(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    generation.current++
    void load()
    return () => {
      generation.current++
      if (handle.current) void api?.marketplaceCancel({ selectionId: handle.current })
      handle.current = null
    }
  }, [projectPath, api])
  useEffect(() => {
    if (previousRefresh.current === refreshRequest) return
    previousRefresh.current = refreshRequest
    void load(true)
  }, [refreshRequest])
  useEffect(() => {
    if (previousAdd.current === sourceAddRequest) return
    previousAdd.current = sourceAddRequest
    setSourcesOpen(true)
  }, [sourceAddRequest])
  async function receive(result: MarketplaceOperation): Promise<void> {
    const current = generation.current
    setOperation(result)
    if (result.status === "installed") {
      notify(`${result.message} 新版本将在下次对话中生效。`)
      await load()
      if (current !== generation.current) return
      const snapshot = await api?.snapshot({ cwd: projectPath }).catch(() => undefined)
      if (current === generation.current && snapshot)
        setInstalled(snapshot.plugins.find((p) => p.identity.id === result.pluginId) ?? null)
    }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    const current = generation.current
    try {
      await action()
    } catch (cause) {
      if (current === generation.current) setError(pluginErrorMessage(cause))
    } finally {
      lock.current = false
      if (current === generation.current) setBusy(false)
    }
  }
  async function preview(entry: MarketplaceEntry): Promise<void> {
    if (!api) return
    const current = generation.current
    await run(async () => {
      const result = await api.marketplacePreview({
        cwd: projectPath,
        sourceId: entry.sourceId,
        pluginId: entry.plugin.id,
        version: entry.plugin.version,
      })
      if (current !== generation.current) {
        await api.marketplaceCancel({ selectionId: result.selectionId })
        return
      }
      if (result.operation) await receive(result.operation)
      else {
        handle.current = result.selectionId
        setApproval(result)
      }
    })
  }
  async function cancel(): Promise<void> {
    const selectionId = handle.current
    handle.current = null
    setApproval(null)
    if (selectionId) await api?.marketplaceCancel({ selectionId })
  }
  const entries = catalog.entries.filter((entry) =>
    [entry.plugin.displayName, entry.plugin.name, entry.plugin.description, entry.plugin.category]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  )
  const sourceName = (id: string): string => catalog.sources.find((s) => s.id === id)?.name ?? id
  function action(entry: MarketplaceEntry): React.JSX.Element {
    const installed = Boolean(entry.installedVersion)
    const sameSource = entry.installedSourceId === entry.sourceId
    const sourceChange = installed && !sameSource
    const alreadyInstalled = installed && sameSource && !entry.updateAvailable
    const label = !entry.compatible
      ? "不兼容"
      : sourceChange
        ? entry.installedSourceId
          ? "更换来源"
          : "关联来源"
        : entry.updateAvailable
          ? "更新"
          : installed
            ? "已安装"
            : "安装"
    return (
      <Button
        shape="pill"
        variant={alreadyInstalled ? "outline" : "default"}
        disabled={busy || !entry.compatible || alreadyInstalled}
        onClick={() => void preview(entry)}
      >
        {label}
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end gap-2">
        <Button variant="ghost" shape="pill" disabled={busy} onClick={() => void load(true)}>
          刷新市场
        </Button>
        <Button variant="outline" shape="pill" onClick={() => setSourcesOpen(true)}>
          管理插件源
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {catalog.sources
        .filter((s) => s.stale || s.error)
        .map((s) => (
          <p key={s.id} role="status" className="text-xs text-muted-foreground">
            {s.name}：{s.error ?? "当前显示离线缓存"}
            {s.updatedAt ? ` · 缓存时间 ${new Date(s.updatedAt).toLocaleString()}` : ""}
          </p>
        ))}
      {operation ? (
        <div role="status" className="flex items-center gap-3 text-sm">
          <span>{operation.message}</span>
          {operation.status === "unknown" || operation.status === "pending" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!api) return
                  const current = generation.current
                  const result = await api.marketplaceOperation({
                    cwd: projectPath,
                    operationId: operation.operationId,
                  })
                  if (current === generation.current) await receive(result)
                })
              }
            >
              检查安装结果
            </Button>
          ) : null}
          {installed && onUse ? (
            <Button shape="pill" onClick={() => void onUse(installed, "")}>
              新建对话使用
            </Button>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载市场…
        </p>
      ) : entries.length ? (
        <div className="divide-y divide-border/50">
          {entries.map((entry) => (
            <div
              key={`${entry.sourceId}:${entry.plugin.id}`}
              className="flex min-h-20 items-center gap-4 py-4"
            >
              <button
                className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                onClick={() => setSelected(entry)}
              >
                <span className="text-sm font-semibold">
                  {entry.plugin.displayName ?? entry.plugin.name}
                </span>
                <span className="text-sm text-muted-foreground">{entry.plugin.description}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.plugin.author?.name ? `${entry.plugin.author.name} · ` : ""}
                  {entry.plugin.version} · {entry.plugin.category} ·{" "}
                  {capabilities(entry.plugin.componentTypes)} · {sourceName(entry.sourceId)}
                  {entry.installedVersion
                    ? ` · 已安装 ${entry.installedVersion} · ${entry.installedSourceId ? `安装来源：${catalog.sources.find((source) => source.id === entry.installedSourceId)?.name ?? "其他插件源"}` : "未关联插件源"}`
                    : ""}
                </span>
                {!entry.compatible ? (
                  <span className="text-xs text-destructive">{entry.incompatibility}</span>
                ) : null}
              </button>
              {action(entry)}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-sm text-muted-foreground">没有找到匹配的市场插件。</p>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.plugin.displayName ?? selected?.plugin.name}</DialogTitle>
            <DialogDescription>{selected?.plugin.description}</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>
                {selected.plugin.author?.name ? `作者：${selected.plugin.author.name} · ` : ""}版本{" "}
                {selected.plugin.version}
              </p>
              <p>来源：{sourceName(selected.sourceId)}</p>
              <p>
                分类：{selected.plugin.category} · 能力：
                {capabilities(selected.plugin.componentTypes)}
              </p>
              <p>{selected.compatible ? "与当前版本兼容" : selected.incompatibility}</p>
              {action(selected)}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(approval)}
        onOpenChange={(open) => {
          if (!open && !busy) void cancel()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>安装「{approval?.pluginName}」？</DialogTitle>
            <DialogDescription>
              {approval?.replacementRequired
                ? `将用「${approval.sourceName}」提供的版本替换现有安装，并更换其来源。`
                : `来自「${approval?.sourceName}」。请确认插件实际申请的权限。`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            {groupPermissions(approval?.requestedPermissions ?? []).map((group) => (
              <div key={group.label}>
                <p className="font-medium">{group.label}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {group.values.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {!approval?.requestedPermissions.length ? (
            <p className="text-sm text-muted-foreground">此插件未申请权限。</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!api || !approval) return
                  const current = generation.current
                  const result = await api.marketplaceConfirm({
                    cwd: projectPath,
                    selectionId: approval.selectionId,
                  })
                  handle.current = null
                  if (current !== generation.current) return
                  setApproval(null)
                  await receive(result)
                })
              }
            >
              确认安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>插件源</DialogTitle>
            <DialogDescription>
              添加 HTTPS 市场索引。移除来源会保留已安装插件及数据。
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              aria-label="插件源地址"
              placeholder="https://example.com/marketplace.json"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button
              disabled={busy || !url.trim()}
              onClick={() =>
                void run(async () => {
                  if (!api) return
                  await api.marketplaceAddSource({ url: url.trim() })
                  setUrl("")
                  await load(true)
                })
              }
            >
              添加插件源
            </Button>
          </div>
          <div className="divide-y divide-border/50">
            {catalog.sources.map((source) => (
              <div key={source.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {source.name}
                    {source.builtin ? "（内置）" : ""}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">{source.url}</p>
                </div>
                <Switch
                  aria-label={`${source.enabled ? "禁用" : "启用"} ${source.name}`}
                  checked={source.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void run(async () => {
                      if (!api) return
                      await cancel()
                      await api.marketplaceSetSourceEnabled({ sourceId: source.id, enabled })
                      await load(true)
                    })
                  }
                />
                {!source.builtin ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!api) return
                        await cancel()
                        await api.marketplaceRemoveSource({ sourceId: source.id })
                        await load(true)
                      })
                    }
                  >
                    移除 {source.name}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
