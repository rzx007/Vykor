import { useEffect, useRef, useState } from "react"
import { CircleAlert, Ellipsis, Trash2 } from "lucide-react"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Spinner } from "@renderer/components/ui/spinner"
import { Switch } from "@renderer/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import type {
  DesktopPluginArchiveConfirmResult,
  DesktopPluginArchiveFailureDetail,
  DesktopPluginArchiveImportResult,
  DesktopPluginInfo,
  DesktopPluginSnapshot,
} from "@shared/plugin-types"
import { PluginDetailsDialog } from "../settings-page/plugin-settings"
import { ExtensionIcon } from "./plugin-catalog"
export interface PluginManagerProps {
  query: string
  addRequest: number
  refreshRequest: number
  projectPath: string
  notify: (message: string) => void
}
type ImportFeedback = {
  message: string
  details?: DesktopPluginArchiveFailureDetail[]
  variant?: "destructive"
}
type Approval = Extract<DesktopPluginArchiveImportResult, { status: "approval-required" }>
const permissionLabels: Record<string, string> = {
  filesystem: "文件访问",
  network: "网络访问",
  process: "运行程序",
  secrets: "密钥访问",
  tool: "工具权限",
}
const displayName = (plugin: DesktopPluginInfo): string =>
  plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id
const needsAttention = (plugin: DesktopPluginInfo): boolean =>
  plugin.runtimeStatus.state === "failed" || plugin.runtimeStatus.state === "degraded"
const pluginRuntimeLabel = (plugin: DesktopPluginInfo): string => plugin.runtimeStatus.message
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error: /,
    ""
  )
function groupPermissions(permissions: string[]): Array<{ label: string; values: string[] }> {
  const groups = new Map<string, string[]>()
  for (const permission of permissions) {
    const prefix = permission.split(/[:/]/u, 1)[0]
    const label = permissionLabels[prefix] ?? "其他权限"
    const suffix = permission.slice(prefix.length).replace(/^[:/]/u, "") || permission
    const values = groups.get(label) ?? []
    if (!values.includes(suffix)) values.push(suffix)
    groups.set(label, values)
  }
  return [...groups].map(([label, values]) => ({ label, values }))
}
export function PluginManager({
  query,
  addRequest,
  refreshRequest,
  projectPath,
  notify,
}: PluginManagerProps): React.JSX.Element {
  const api = window.desktop?.plugins
  const [snapshot, setSnapshot] = useState<DesktopPluginSnapshot | null>(null)
  const [loading, setLoading] = useState(Boolean(api))
  const [busy, setBusy] = useState(Boolean(api))
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null)
  const [filter, setFilter] = useState("all")
  const [detailId, setDetailId] = useState<string | null>(null)
  const [removal, setRemoval] = useState<{ id: string; name: string } | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [queuedImport, setQueuedImport] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const loadId = useRef(0)
  const previousRefresh = useRef(refreshRequest)
  const previousAdd = useRef(0)
  const cancelledSelection = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!api) return
    const requestId = ++loadId.current
    let cancelled = false
    lock.current = true
    void api
      .snapshot({ cwd: projectPath })
      .then((value) => {
        if (!cancelled) setSnapshot(value)
      })
      .catch((cause) => {
        if (!cancelled) setFeedback({ message: errorText(cause), variant: "destructive" })
      })
      .finally(() => {
        if (requestId === loadId.current) lock.current = false
        if (!cancelled) {
          setLoading(false)
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, projectPath])
  function applyImportResult(
    result: DesktopPluginArchiveImportResult | DesktopPluginArchiveConfirmResult
  ): void {
    if (result.status === "cancelled") return
    if (result.status === "approval-required") {
      cancelledSelection.current = null
      setApproval(result)
      return
    }
    if (result.status === "installed") {
      if (result.snapshot) setSnapshot(result.snapshot)
      notify(
        result.snapshot
          ? `${result.pluginName} 已安装或更新，将在下次对话中生效。`
          : `${result.pluginName} 已安装或更新，将在下次对话中生效。插件列表可刷新。`
      )
      return
    }
    if (result.status === "unknown") {
      setFeedback({ message: result.message, details: result.details })
      return
    }
    setFeedback({
      message: result.message || "导入插件失败，请重试。",
      details: result.details,
      variant: "destructive",
    })
  }
  async function importArchive(): Promise<void> {
    if (!api || lock.current) return
    lock.current = true
    setBusy(true)
    setFeedback(null)
    try {
      applyImportResult(await api.importArchive({ cwd: projectPath }))
    } catch {
      if (mounted.current)
        setFeedback({ message: "导入插件失败，请重试。", variant: "destructive" })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function confirmArchive(): Promise<void> {
    if (!api || !approval || lock.current) return
    lock.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const result = await api.confirmArchive({
        cwd: projectPath,
        selectionId: approval.selectionId,
      })
      if (!mounted.current) return
      setApproval(null)
      applyImportResult(result)
    } catch {
      if (mounted.current)
        setFeedback({ message: "导入插件失败，请重试。", variant: "destructive" })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function cancelArchive(): Promise<void> {
    if (!api || !approval || busy || cancelledSelection.current === approval.selectionId) return
    cancelledSelection.current = approval.selectionId
    const selectionId = approval.selectionId
    setApproval(null)
    try {
      await api.cancelArchive({ selectionId })
    } catch {
      if (mounted.current)
        setFeedback({ message: "取消导入失败，请重试。", variant: "destructive" })
    }
  }
  useEffect(() => {
    if (!addRequest || addRequest === previousAdd.current) return
    previousAdd.current = addRequest
    if (lock.current) {
      setQueuedImport(true)
      return
    }
    void importArchive()
  }, [addRequest])
  useEffect(() => {
    if (!queuedImport || busy || lock.current) return
    setQueuedImport(false)
    void importArchive()
  }, [busy, queuedImport])
  useEffect(() => {
    if (refreshRequest === previousRefresh.current || !api || lock.current) return
    previousRefresh.current = refreshRequest
    lock.current = true
    setBusy(true)
    setFeedback(null)
    void api
      .reload({ cwd: projectPath })
      .then((value) => {
        if (mounted.current) {
          setSnapshot(value)
          notify("插件列表已刷新。")
        }
      })
      .catch((cause) => {
        if (mounted.current) setFeedback({ message: errorText(cause), variant: "destructive" })
      })
      .finally(() => {
        lock.current = false
        if (mounted.current) setBusy(false)
      })
  }, [api, notify, projectPath, refreshRequest])
  async function mutate(plugin: DesktopPluginInfo, uninstall = false): Promise<void> {
    if (!api || lock.current || plugin.scope === "managed") return
    lock.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const input = { cwd: projectPath, pluginId: plugin.identity.id }
      const result = await (uninstall
        ? api.uninstall(input)
        : plugin.enabled
          ? api.disable(input)
          : api.enable(input))
      if (!mounted.current) return
      setSnapshot(result)
      if (uninstall) {
        setRemoval(null)
        setDetailId(null)
      }
      notify(`${displayName(plugin)} 已${uninstall ? "卸载" : plugin.enabled ? "禁用" : "启用"}。`)
    } catch (cause) {
      if (mounted.current) setFeedback({ message: errorText(cause), variant: "destructive" })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = (...values: (string | undefined)[]): boolean =>
    values.join(" ").toLocaleLowerCase().includes(normalizedQuery)
  const plugins = snapshot?.plugins ?? []
  const visiblePlugins = plugins.filter(
    (plugin) =>
      matches(
        displayName(plugin),
        plugin.identity.id,
        plugin.identity.version,
        plugin.sourceFormat
      ) &&
      (filter === "all" || (filter === "enabled" ? plugin.enabled : needsAttention(plugin)))
  )
  const detail = plugins.find((plugin) => plugin.identity.id === detailId) ?? null
  return (
    <div className="flex flex-col gap-9">
      {feedback ? <ImportFeedbackAlert feedback={feedback} /> : null}
      {snapshot?.warnings.length ? (
        <Alert>
          <CircleAlert />
          <AlertDescription>{snapshot.warnings.join("；")}</AlertDescription>
        </Alert>
      ) : null}
      <section className="flex flex-col gap-4" aria-labelledby="plugin-installed-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="plugin-installed-title" className="text-sm font-medium">
            已安装
          </h2>
        </div>
        <Separator className="bg-border/50" />
        {loading ? (
          <div className="flex gap-6 py-2" aria-label="正在加载插件">
            {[1, 2, 3, 4].map((id) => (
              <Skeleton key={id} className="size-11 rounded-xl" />
            ))}
          </div>
        ) : plugins.length ? (
          <div className="flex flex-wrap gap-x-5 gap-y-3 py-1" aria-label="已安装插件">
            {plugins
              .filter((plugin) => matches(displayName(plugin), plugin.identity.id))
              .map((plugin) => (
                <Tooltip key={plugin.identity.id}>
                  <TooltipTrigger
                    className="relative rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`查看 ${displayName(plugin)} 详情`}
                    onClick={() => setDetailId(plugin.identity.id)}
                  >
                    <ExtensionIcon name={displayName(plugin)} />
                    {needsAttention(plugin) ? (
                      <CircleAlert className="absolute -right-1 -bottom-1 size-4 rounded-full bg-background text-destructive" />
                    ) : null}
                  </TooltipTrigger>
                  <TooltipContent>
                    {displayName(plugin)} · {pluginRuntimeLabel(plugin)}
                  </TooltipContent>
                </Tooltip>
              ))}
          </div>
        ) : (
          <NoPlugins />
        )}
      </section>
      {plugins.length ? (
        <section className="flex flex-col gap-3" aria-labelledby="plugin-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="plugin-list-title" className="text-sm font-medium">
              我的插件
            </h2>
            <ToggleGroup
              value={[filter]}
              onValueChange={(value) => value[0] && setFilter(value[0])}
              size="sm"
              aria-label="插件状态"
            >
              <ToggleGroupItem value="all">全部</ToggleGroupItem>
              <ToggleGroupItem value="enabled">已启用</ToggleGroupItem>
              <ToggleGroupItem value="attention">需处理</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Separator />
          {visiblePlugins.length ? (
            <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
              {visiblePlugins.map((plugin) => (
                <ExtensionRow
                  key={plugin.identity.id}
                  name={displayName(plugin)}
                  description={`${plugin.identity.version} · ${plugin.scope === "managed" ? "由组织管理" : "个人安装"} · ${pluginRuntimeLabel(plugin)}`}
                  onClick={() => setDetailId(plugin.identity.id)}
                  action={
                    <div className="flex items-center gap-2">
                      <Switch
                        size="sm"
                        checked={plugin.enabled}
                        disabled={busy || plugin.scope === "managed"}
                        aria-label={`${plugin.enabled ? "禁用" : "启用"} ${displayName(plugin)}`}
                        onCheckedChange={() => void mutate(plugin)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" />}
                          aria-label={`${displayName(plugin)} 更多操作`}
                        >
                          <Ellipsis />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => setDetailId(plugin.identity.id)}>
                              查看详情
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busy || plugin.scope === "managed"}
                              variant="destructive"
                              onClick={() =>
                                setRemoval({ id: plugin.identity.id, name: displayName(plugin) })
                              }
                            >
                              卸载
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  }
                />
              ))}
            </div>
          ) : (
            <NoPlugins searched={Boolean(normalizedQuery) || filter !== "all"} />
          )}
        </section>
      ) : null}
      <PluginDetailsDialog
        error=""
        plugin={detail}
        onOpenChange={(open) => !open && setDetailId(null)}
        actions={
          detail ? (
            <div className="flex items-center justify-between gap-3 py-2">
              <label className="flex items-center gap-3">
                <Switch
                  checked={detail.enabled}
                  disabled={busy || detail.scope === "managed"}
                  onCheckedChange={() => void mutate(detail)}
                />
                {detail.scope === "managed" ? "由组织管理" : detail.enabled ? "已启用" : "已禁用"}
              </label>
              <Button
                variant="destructive"
                disabled={busy || detail.scope === "managed"}
                onClick={() => setRemoval({ id: detail.identity.id, name: displayName(detail) })}
              >
                <Trash2 data-icon="inline-start" />
                卸载
              </Button>
            </div>
          ) : null
        }
      />
      <AlertDialog
        open={Boolean(removal)}
        onOpenChange={(open) => !open && !busy && setRemoval(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载插件 {removal?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              将移除插件安装记录与缓存。本地链接插件的源目录不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const plugin = plugins.find((item) => item.identity.id === removal?.id)
                if (plugin) void mutate(plugin, true)
              }}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              确认卸载
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(approval)}
        onOpenChange={(open) => {
          if (!open) void cancelArchive()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>安装「{approval?.pluginName}」？</AlertDialogTitle>
            <AlertDialogDescription>该插件需要以下权限才能正常工作。</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            {groupPermissions(approval?.requestedPermissions ?? []).map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <p className="font-medium">{group.label}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {group.values.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={() => void cancelArchive()}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void confirmArchive()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
function ImportFeedbackAlert({ feedback }: { feedback: ImportFeedback }): React.JSX.Element {
  return (
    <Alert variant={feedback.variant}>
      <CircleAlert />
      <AlertDescription>
        <p>{feedback.message}</p>
        {feedback.details?.length ? (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="link" size="sm" className="px-0" />}>
              查看详情
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {feedback.details.map((detail, index) => (
                  <li key={`${detail.code}-${detail.path ?? index}`}>
                    {detail.code}
                    {detail.path ? ` · ${detail.path}` : ""}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
function ExtensionRow({
  name,
  description,
  onClick,
  action,
}: {
  name: string
  description: string
  onClick: () => void
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-extension-row
      className="group flex min-h-20 min-w-0 items-center gap-3 rounded-xl px-1 py-3"
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClick}
      >
        <ExtensionIcon name={name} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold group-hover:underline group-hover:underline-offset-4">
            {name}
          </span>
          <span className="truncate text-sm text-muted-foreground" title={description}>
            {description}
          </span>
        </span>
      </button>
      {action}
    </div>
  )
}
function NoPlugins({ searched }: { searched?: boolean }): React.JSX.Element {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyTitle>{searched ? "没有找到匹配的插件" : "还没有插件"}</EmptyTitle>
        {searched ? <EmptyDescription>试试其他关键词或切换筛选条件。</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  )
}
