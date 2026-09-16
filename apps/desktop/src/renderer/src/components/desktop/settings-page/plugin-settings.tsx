import {
  Box,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

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
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Switch } from "@renderer/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopPluginInfo, DesktopPluginSnapshot } from "@shared/plugin-types"

type PluginFilter = "all" | "enabled" | "attention"

const scopeLabels: Record<DesktopPluginInfo["scope"], string> = {
  user: "用户",
  managed: "托管",
}

const activationLabels: Record<DesktopPluginInfo["activation"], string> = {
  inactive: "未激活",
  active: "运行中",
  partial: "部分可用",
  "reload-required": "需要重载",
}

const runtimeActionHints = {
  enable: "启用后下次对话生效。",
  reload: "新开对话或重载插件后生效。",
  reimport: "请重新导入插件包。",
  approve: "请重新导入并确认新增权限。",
  disable: "可以先禁用该插件。",
  uninstall: "可以卸载该插件。",
  details: "请查看下方诊断详情。",
  none: "",
} satisfies Record<DesktopPluginInfo["runtimeStatus"]["action"], string>

export function PluginSettings(): React.JSX.Element {
  const pluginApi = window.desktop.plugins
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const sessionCwd = useDesktopSessionStore((state) => state.sessionView?.session.cwd)
  const cwd = selectedProject?.path ?? sessionCwd ?? "."
  const [snapshot, setSnapshot] = useState<DesktopPluginSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<PluginFilter>("all")
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [detailTarget, setDetailTarget] = useState<DesktopPluginInfo | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<DesktopPluginInfo | null>(null)
  const mutationInFlight = useRef(false)

  useEffect(() => {
    if (!pluginApi) return
    let cancelled = false
    void pluginApi
      .snapshot({ cwd })
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, pluginApi])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [message])

  const plugins = useMemo(() => snapshot?.plugins ?? [], [snapshot])
  const attentionCount = plugins.filter(needsAttention).length
  const filteredPlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return plugins.filter((plugin) => {
      if (filter === "enabled" && !plugin.enabled) return false
      if (filter === "attention" && !needsAttention(plugin)) return false
      if (!normalizedQuery) return true
      return [
        plugin.identity.id,
        plugin.identity.name,
        plugin.identity.displayName,
        plugin.identity.version,
        plugin.scope,
        plugin.sourceFormat,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    })
  }, [filter, plugins, query])

  const runMutation = async (
    plugin: DesktopPluginInfo,
    operation: () => Promise<DesktopPluginSnapshot>,
    successMessage: string
  ): Promise<boolean> => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setBusyPlugin(plugin.identity.id)
    setError(null)
    setMessage(null)
    try {
      const nextSnapshot = await operation()
      setSnapshot(nextSnapshot)
      setDetailTarget((current) =>
        current?.identity.id === plugin.identity.id
          ? (nextSnapshot.plugins.find((item) => item.identity.id === plugin.identity.id) ?? null)
          : current
      )
      setMessage(successMessage)
      return true
    } catch (mutationError) {
      setError(errorMessage(mutationError))
      return false
    } finally {
      mutationInFlight.current = false
      setBusyPlugin(null)
    }
  }

  const togglePlugin = (plugin: DesktopPluginInfo): void => {
    const input = { cwd, pluginId: plugin.identity.id }
    void runMutation(
      plugin,
      () => (plugin.enabled ? pluginApi.disable(input) : pluginApi.enable(input)),
      `${pluginDisplayName(plugin)} 已${plugin.enabled ? "禁用" : "启用"}。`
    )
  }

  const reload = async (): Promise<void> => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    setReloading(true)
    setError(null)
    setMessage(null)
    try {
      setSnapshot(await pluginApi.reload({ cwd }))
      setMessage("插件注册表和运行状态已重新加载。")
    } catch (reloadError) {
      setError(errorMessage(reloadError))
    } finally {
      mutationInFlight.current = false
      setReloading(false)
    }
  }

  const uninstall = (): void => {
    if (!uninstallTarget) return
    const plugin = uninstallTarget
    void runMutation(
      plugin,
      () => pluginApi.uninstall({ cwd, pluginId: plugin.identity.id }),
      `${pluginDisplayName(plugin)} 已卸载。`
    ).then((succeeded) => {
      if (succeeded) setUninstallTarget(null)
    })
  }

  if (!pluginApi) {
    return (
      <Alert>
        <CircleAlert />
        <AlertDescription>
          插件管理接口尚未加载。请完全退出并重新启动 OpenHarness，以更新 Desktop preload。
        </AlertDescription>
      </Alert>
    )
  }

  if (loading) return <PluginSettingsSkeleton />

  return (
    <div className="flex flex-col gap-7">
      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <div
          role="status"
          className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
        >
          <CircleCheck className="size-3.5 text-foreground/70" aria-hidden="true" />
          <span>{message}</span>
        </div>
      ) : null}
      {snapshot?.warnings.map((warning) => (
        <Alert key={warning}>
          <CircleAlert />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}

      <InputGroup className="h-9 shadow-none">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、ID、版本或来源"
          aria-label="搜索插件"
        />
      </InputGroup>

      <section className="flex flex-col gap-4" aria-labelledby="installed-plugin-heading">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="installed-plugin-heading" className="text-base font-semibold">
              已安装
            </h2>
            <p className="text-xs text-muted-foreground">
              {plugins.length} 个插件 · {plugins.filter((plugin) => plugin.enabled).length} 个已启用
              {attentionCount ? ` · ${attentionCount} 个需要处理` : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-8 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => void reload()}
            disabled={reloading}
          >
            <RefreshCw
              data-icon="inline-start"
              className={reloading ? "animate-spin" : undefined}
            />
            {reloading ? "重载中..." : "重载插件"}
          </Button>
        </div>

        {plugins.length ? (
          <div className="flex min-h-16 flex-wrap items-start gap-2" aria-label="插件快捷入口">
            {plugins.map((plugin) => (
              <Tooltip key={plugin.identity.id}>
                <TooltipTrigger
                  aria-label={`查看 ${pluginDisplayName(plugin)} 详情`}
                  className="group flex w-16 flex-col items-center gap-1.5 rounded-lg px-1 py-1.5 text-center outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setDetailTarget(plugin)}
                >
                  <PluginIcon plugin={plugin} />
                  <span className="text-ui-caption w-full truncate text-muted-foreground group-hover:text-foreground">
                    {pluginDisplayName(plugin)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{plugin.identity.id}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-b border-border/60">
          <span className="pb-2 text-xs text-muted-foreground">插件列表</span>
          <Tabs value={filter} onValueChange={(value) => setFilter(value as PluginFilter)}>
            <TabsList variant="line" className="h-8">
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="enabled">已启用</TabsTrigger>
              <TabsTrigger value="attention">需处理</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {filteredPlugins.length ? (
          <ItemGroup className="gap-0">
            {filteredPlugins.map((plugin, index) => (
              <PluginRow
                key={plugin.identity.id}
                plugin={plugin}
                busy={busyPlugin === plugin.identity.id}
                locked={busyPlugin !== null || reloading}
                onDetails={() => setDetailTarget(plugin)}
                onToggle={() => togglePlugin(plugin)}
                onUninstall={() => setUninstallTarget(plugin)}
                separated={index > 0}
              />
            ))}
          </ItemGroup>
        ) : (
          <Empty className="min-h-44 py-10">
            <EmptyHeader className="gap-1.5">
              <EmptyMedia>
                <Plug className="size-5 text-muted-foreground/60" />
              </EmptyMedia>
              <EmptyTitle className="text-sm">
                {plugins.length ? "没有匹配的插件" : "还没有安装插件"}
              </EmptyTitle>
              <EmptyDescription className="max-w-sm text-xs leading-5">
                {plugins.length
                  ? "调整搜索词或筛选条件后再试。"
                  : "可先使用 ohs plugin install-local 或 ohs plugin link 添加本地插件。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>

      <PluginDetailsDialog
        plugin={detailTarget}
        onOpenChange={(open) => !open && setDetailTarget(null)}
      />

      <AlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => !open && !busyPlugin && setUninstallTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              卸载 {uninstallTarget ? pluginDisplayName(uninstallTarget) : "插件"}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将移除插件的安装记录和缓存。local linked 插件的源目录不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyPlugin !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyPlugin !== null}
              onClick={uninstall}
            >
              {busyPlugin ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : null}
              {busyPlugin ? "卸载中..." : "卸载插件"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PluginRow({
  plugin,
  busy,
  locked,
  onDetails,
  onToggle,
  onUninstall,
  separated,
}: {
  plugin: DesktopPluginInfo
  busy: boolean
  locked: boolean
  onDetails: () => void
  onToggle: () => void
  onUninstall: () => void
  separated: boolean
}): React.JSX.Element {
  const managed = plugin.scope === "managed"
  return (
    <>
      {separated ? <Separator /> : null}
      <Item className="min-h-16 rounded-none border-0 px-1 py-3.5">
        <ItemMedia>
          <PluginIcon plugin={plugin} compact />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {pluginDisplayName(plugin)}
            <Badge variant="ghost">{scopeLabels[plugin.scope]}</Badge>
            <PluginHealthBadge plugin={plugin} />
          </ItemTitle>
          <ItemDescription>
            {plugin.identity.id} · v{plugin.identity.version} ·{" "}
            {plugin.origin === "converted"
              ? `转换自 ${plugin.sourceFormat ?? "外部插件"}`
              : "原生插件"}
          </ItemDescription>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{plugin.runtimeStatus.message}</span>
            <span>{inventorySummary(plugin)}</span>
            {plugin.toolRuntime ? (
              <span>Tool Runtime：{runtimeLabel(plugin.toolRuntime.state)}</span>
            ) : null}
          </div>
        </ItemContent>
        <ItemActions>
          {busy ? (
            <LoaderCircle className="animate-spin text-muted-foreground" aria-label="处理中" />
          ) : null}
          <Switch
            size="sm"
            checked={plugin.enabled}
            onCheckedChange={onToggle}
            disabled={locked || managed}
            aria-label={`${plugin.enabled ? "禁用" : "启用"}${pluginDisplayName(plugin)}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${pluginDisplayName(plugin)}的更多操作`}
              className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted [&_svg]:size-4"
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={onDetails}>
                  <Info />
                  查看详情
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={onUninstall}
                  disabled={locked || managed}
                >
                  <Trash2 />
                  卸载
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </Item>
    </>
  )
}

export function PluginDetailsDialog({
  plugin,
  onOpenChange,
  actions,
  error,
}: {
  plugin: DesktopPluginInfo | null
  onOpenChange: (open: boolean) => void
  actions?: React.ReactNode
  error?: string
}): React.JSX.Element {
  if (!plugin) return <></>
  const runtime = plugin.toolRuntime
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto p-6 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{pluginDisplayName(plugin)}</DialogTitle>
          <DialogDescription>
            {plugin.identity.id}@{plugin.identity.version} · {scopeLabels[plugin.scope]}
          </DialogDescription>
        </DialogHeader>
        {actions}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-6 text-sm">
          <DetailSection title="安装状态">
            <DetailRow
              label="来源"
              value={
                plugin.origin === "converted"
                  ? `转换自 ${plugin.sourceFormat ?? "外部格式"}`
                  : "OpenHarness 原生"
              }
            />
            <DetailRow label="安装" value={plugin.installation} />
            <DetailRow label="激活" value={activationLabels[plugin.activation]} />
            <DetailRow label="运行状态" value={plugin.runtimeStatus.message} />
            {runtimeActionHint(plugin) ? (
              <DetailRow label="建议" value={runtimeActionHint(plugin)} />
            ) : null}
          </DetailSection>
          <DetailSection title="贡献内容">
            {Object.entries(plugin.inventory).length ? (
              Object.entries(plugin.inventory).map(([name, count]) => (
                <DetailRow key={name} label={name} value={String(count)} />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">没有声明贡献内容。</p>
            )}
          </DetailSection>
          <DetailSection title="权限">
            <DetailRow
              label="已批准"
              value={`${plugin.permissions.approved.length}/${plugin.permissions.requested.length}`}
            />
            <DetailRow label="请求" value={plugin.permissions.requested.join(", ") || "无"} />
            <DetailRow label="缺失" value={plugin.permissions.missing.join(", ") || "无"} />
          </DetailSection>
          {runtime ? (
            <DetailSection title="Tool Runtime">
              <DetailRow label="状态" value={runtimeLabel(runtime.state)} />
              <DetailRow
                label="入口"
                value={`${runtime.activatableEntries}/${runtime.declaredEntries} 可激活`}
              />
              <DetailRow label="Host" value={String(runtime.hostCount)} />
              <DetailRow label="已注册工具" value={String(runtime.registeredToolCount)} />
              {runtime.lastError ? <DetailRow label="最近错误" value={runtime.lastError} /> : null}
            </DetailSection>
          ) : null}
          <DetailSection title="诊断">
            {plugin.diagnostics.length ? (
              plugin.diagnostics.map((diagnostic, index) => (
                <Alert
                  key={`${diagnostic.code}-${index}`}
                  variant={diagnostic.severity === "error" ? "destructive" : "default"}
                >
                  <CircleAlert />
                  <AlertDescription>
                    <span className="font-medium">{diagnostic.code}</span> · {diagnostic.message}
                  </AlertDescription>
                </Alert>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">没有诊断问题。</p>
            )}
          </DetailSection>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  )
}

function PluginIcon({
  plugin,
  compact = false,
}: {
  plugin: DesktopPluginInfo
  compact?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center rounded-lg bg-muted text-foreground",
        compact ? "size-9" : "size-10"
      )}
    >
      {plugin.origin === "converted" ? <Box aria-hidden="true" /> : <Plug aria-hidden="true" />}
      {needsAttention(plugin) ? (
        <CircleAlert
          className="absolute -right-1 -bottom-1 size-4 fill-background text-destructive"
          aria-hidden="true"
        />
      ) : null}
    </span>
  )
}

function PluginHealthBadge({ plugin }: { plugin: DesktopPluginInfo }): React.JSX.Element | null {
  if (plugin.runtimeStatus.state === "failed") {
    return <Badge variant="destructive">失败</Badge>
  }
  if (plugin.runtimeStatus.state === "pending_reload") return <Badge variant="secondary">待生效</Badge>
  if (plugin.runtimeStatus.state === "degraded") {
    return <Badge variant="secondary">部分可用</Badge>
  }
  return null
}

function needsAttention(plugin: DesktopPluginInfo): boolean {
  return plugin.runtimeStatus.state === "failed" || plugin.runtimeStatus.state === "degraded"
}

function inventorySummary(plugin: DesktopPluginInfo): string {
  const entries = Object.entries(plugin.inventory).filter(([, count]) => count > 0)
  return entries.length
    ? entries.map(([name, count]) => `${name} ${count}`).join(" · ")
    : "无贡献内容"
}

function runtimeLabel(state: NonNullable<DesktopPluginInfo["toolRuntime"]>["state"]): string {
  const labels = {
    inactive: "未启动",
    "reload-required": "需要重载",
    starting: "启动中",
    active: "运行中",
    degraded: "部分可用",
    error: "错误",
  } satisfies Record<NonNullable<DesktopPluginInfo["toolRuntime"]>["state"], string>
  return labels[state]
}

function pluginDisplayName(plugin: DesktopPluginInfo): string {
  return plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id
}

function runtimeActionHint(plugin: DesktopPluginInfo): string {
  return runtimeActionHints[plugin.runtimeStatus.action]
}

function PluginSettingsSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-7" aria-label="正在加载插件">
      <Skeleton className="h-9 w-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-20" />
        <div className="flex gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="size-10 rounded-lg" />
        </div>
      </div>
      <Skeleton className="h-px w-full" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "")
}
