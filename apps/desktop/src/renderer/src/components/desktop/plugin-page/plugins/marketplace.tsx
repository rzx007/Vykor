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
import { CircleCheck, Plus, RefreshCw, Settings2 } from "lucide-react"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { ExtensionRow } from "../shared/plugin-catalog"
import { MarketplaceDetail } from "./marketplace-detail"

export function Marketplace({
  query,
  projectPath,
  refreshRequest,
  sourceAddRequest = 0,
  notify,
  onUse,
  onDetailChange,
}: {
  query: string
  projectPath: string
  refreshRequest: number
  sourceAddRequest?: number
  notify: (message: string) => void
  onUse?: (plugin: DesktopPluginInfo, prompt: string) => Promise<void>
  onDetailChange?: (open: boolean) => void
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
  const approvalEntry = useRef<MarketplaceEntry | null>(null)
  const operationEntry = useRef<MarketplaceEntry | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const wasDetailOpen = useRef(false)
  const detail =
    selected &&
    catalog.entries.find(
      (entry) => entry.sourceId === selected.sourceId && entry.plugin.id === selected.plugin.id
    )
  const detailOpen = Boolean(detail)
  useEffect(() => {
    if (wasDetailOpen.current && !detailOpen) heading.current?.focus({ preventScroll: true })
    wasDetailOpen.current = detailOpen
    onDetailChange?.(detailOpen)
  }, [detailOpen, onDetailChange])
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
  async function receive(
    result: MarketplaceOperation,
    owner = operationEntry.current
  ): Promise<void> {
    const current = generation.current
    operationEntry.current = owner
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
      if (result.operation) await receive(result.operation, entry)
      else {
        approvalEntry.current = entry
        handle.current = result.selectionId
        setApproval(result)
      }
    })
  }
  async function cancel(): Promise<void> {
    const selectionId = handle.current
    handle.current = null
    setApproval(null)
    approvalEntry.current = null
    if (selectionId) await api?.marketplaceCancel({ selectionId })
  }
  const entries = catalog.entries.filter((entry) =>
    [entry.plugin.displayName, entry.plugin.name, entry.plugin.description, entry.plugin.category]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )
  const sourceName = (id: string): string => catalog.sources.find((s) => s.id === id)?.name ?? id
  const ownsReceipt = Boolean(
    detail &&
    operationEntry.current?.sourceId === detail.sourceId &&
    operationEntry.current.plugin.id === detail.plugin.id
  )
  const canUseInstalled =
    ownsReceipt &&
    operation?.status === "installed" &&
    installed?.identity.id === detail?.plugin.id &&
    installed?.identity.version === detail?.plugin.version &&
    installed?.enabled &&
    installed?.installation === "installed" &&
    installed?.permissions.missing.length === 0 &&
    installed?.runtimeStatus.state !== "failed" &&
    detail?.installedSourceId === detail?.sourceId &&
    !detail?.updateAvailable
  function useInstalled(prompt = ""): void {
    if (!canUseInstalled || !installed || !onUse) return
    void run(async () => {
      await onUse(installed, prompt)
    })
  }
  function action(entry: MarketplaceEntry, inDetail = false): React.JSX.Element {
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
    const addIcon = !inDetail && label === "安装"
    return (
      <Button
        shape={addIcon ? "circle" : "pill"}
        size={addIcon ? "icon-sm" : "sm"}
        variant={inDetail && !alreadyInstalled ? "default" : "ghost"}
        aria-label={addIcon ? `安装 ${entry.plugin.displayName ?? entry.plugin.name}` : label}
        title={entry.compatible ? label : (entry.incompatibility ?? label)}
        disabled={busy || !entry.compatible || alreadyInstalled}
        onClick={() => void preview(entry)}
      >
        {addIcon ? (
          <Plus />
        ) : (
          <>
            {alreadyInstalled ? <CircleCheck data-icon="inline-start" /> : null}
            {label}
          </>
        )}
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      {!detail ? (
        <div className="flex items-center justify-between gap-3">
          <h2 ref={heading} tabIndex={-1} className="text-[15px] font-semibold">
            全部插件
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {loading ? "" : entries.length}
            </span>
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label="刷新市场"
              title="刷新市场"
              disabled={busy}
              onClick={() => void load(true)}
            >
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="sm" shape="pill" onClick={() => setSourcesOpen(true)}>
              <Settings2 data-icon="inline-start" />
              管理插件源
            </Button>
          </div>
        </div>
      ) : null}
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
      {operation && operation.status !== "installed" ? (
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
        </div>
      ) : null}
      {detail ? (
        <MarketplaceDetail
          entry={detail}
          sourceName={sourceName(detail.sourceId)}
          installedSourceName={
            detail.installedSourceId ? sourceName(detail.installedSourceId) : undefined
          }
          onBack={() => setSelected(null)}
          starting={busy}
          onPrompt={canUseInstalled && onUse ? useInstalled : undefined}
          action={
            canUseInstalled && installed && onUse ? (
              <Button shape="pill" disabled={busy} onClick={() => useInstalled()}>
                新建对话使用
              </Button>
            ) : (
              action(detail, true)
            )
          }
          receipt={
            ownsReceipt && operation ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">安装回执 · {operation.message}</summary>
                <p className="mt-2 break-all">{operation.operationId}</p>
              </details>
            ) : undefined
          }
        />
      ) : loading ? (
        <div
          role="status"
          aria-label="正在加载市场"
          className="grid grid-cols-1 gap-x-10 md:grid-cols-2"
        >
          {[1, 2, 3, 4].map((key) => (
            <div key={key} className="flex items-center gap-3 py-3">
              <Skeleton className="size-11 rounded-xl" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length ? (
        <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2" aria-label="市场插件">
          {entries.map((entry) => (
            <ExtensionRow
              key={`${entry.sourceId}:${entry.plugin.id}`}
              name={entry.plugin.displayName ?? entry.plugin.name}
              icon={entry.plugin.icon}
              description={entry.plugin.description}
              onClick={() => setSelected(entry)}
              action={action(entry)}
            />
          ))}
        </div>
      ) : (
        <p className="py-6 text-sm text-muted-foreground">没有找到匹配的市场插件。</p>
      )}
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
                  await receive(result, approvalEntry.current)
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
                  <p className="text-xs break-all text-muted-foreground">{source.url}</p>
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
