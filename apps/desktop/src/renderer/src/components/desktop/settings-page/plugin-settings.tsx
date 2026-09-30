import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Plug,
  RefreshCw,
  Search,
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
import { Button } from "@renderer/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { ItemGroup } from "@renderer/components/ui/item"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { toast } from "@renderer/lib/toast"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopPluginInfo, DesktopPluginSnapshot } from "@shared/plugin-types"
import {
  PluginDetailsDialog,
  PluginIcon,
  PluginRow,
  needsAttention,
  pluginDisplayName,
} from "./plugin-settings-content"

export { PluginDetailsDialog } from "./plugin-settings-content"

type PluginFilter = "all" | "enabled" | "attention"

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
        if (!cancelled) toast.error(errorMessage(loadError))
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
      toast.error(errorMessage(mutationError))
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
    setMessage(null)
    try {
      setSnapshot(await pluginApi.reload({ cwd }))
      setMessage("插件注册表和运行状态已重新加载。")
    } catch (reloadError) {
      toast.error(errorMessage(reloadError))
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
          插件管理接口尚未加载。请完全退出并重新启动 Vykor，以更新 Desktop preload。
        </AlertDescription>
      </Alert>
    )
  }

  if (loading) return <PluginSettingsSkeleton />

  return (
    <div className="flex flex-col gap-7">
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
                  : "可先使用 vk plugin install-local 或 vk plugin link 添加本地插件。"}
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
