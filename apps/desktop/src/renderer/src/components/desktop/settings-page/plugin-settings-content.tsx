import { Box, CircleAlert, Info, LoaderCircle, MoreHorizontal, Plug, Trash2 } from "lucide-react"
import type * as React from "react"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Badge } from "@renderer/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@renderer/components/ui/item"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { cn } from "@renderer/lib/utils"
import type { DesktopPluginInfo } from "@shared/plugin-types"

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

export function PluginRow({
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
                  : "Vykor 原生"
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
          {plugin.uiInventory ? (
            <DetailSection title="插件界面定义">
              <DetailRow label="定义文件" value={String(plugin.uiInventory.manifestCount)} />
              <DetailRow label="静态校验" value={plugin.uiInventory.componentCount === null
                ? "UI 定义数量暂不可确认"
                : `已校验 ${plugin.uiInventory.validatedComponentCount} 个 UI 定义`} />
              <p className="text-xs text-muted-foreground">交互界面尚未接入。</p>
            </DetailSection>
          ) : null}
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

export function PluginIcon({
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
  if (plugin.runtimeStatus.state === "pending_reload")
    return <Badge variant="secondary">待生效</Badge>
  if (plugin.runtimeStatus.state === "degraded") {
    return <Badge variant="secondary">部分可用</Badge>
  }
  return null
}

export function needsAttention(plugin: DesktopPluginInfo): boolean {
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

export function pluginDisplayName(plugin: DesktopPluginInfo): string {
  return plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id
}

function runtimeActionHint(plugin: DesktopPluginInfo): string {
  return runtimeActionHints[plugin.runtimeStatus.action]
}
