import { groupPermissions } from "./plugin-permissions"
import { Marketplace } from "./marketplace"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty"
import { Input } from "@renderer/components/ui/input"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Spinner } from "@renderer/components/ui/spinner"
import { Switch } from "@renderer/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/motion/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { toast } from "@renderer/lib/toast"
import { pluginErrorMessage as errorText } from "@renderer/lib/plugin-error"
import type {
  DesktopPluginArchiveConfirmResult,
  DesktopPluginArchiveFailureDetail,
  DesktopPluginArchiveImportResult,
  DesktopPluginInfo,
  DesktopPluginSnapshot,
} from "@shared/plugin-types"
import { PluginDetailsDialog } from "../../settings-page/plugins/plugin-settings"
import { ExtensionIcon, ExtensionRow } from "../shared/plugin-catalog"
import { PluginDetail } from "./plugin-detail"
export interface PluginManagerProps {
  query: string
  sourceAddRequest?: number
  addRequest: number
  gitAddRequest: number
  refreshRequest: number
  projectPath: string
  notify: (message: string) => void
  onDetailChange?: (open: boolean) => void
  onUse?: (plugin: DesktopPluginInfo, prompt: string) => Promise<void>
}
export function PluginManager(props: PluginManagerProps): React.JSX.Element {
  const [mode, setMode] = useState("installed")
  const [marketDetail, setMarketDetail] = useState(false)
  const [installedDetail, setInstalledDetail] = useState(false)
  const detailOpen = mode === "marketplace" ? marketDetail : installedDetail
  useEffect(() => {
    props.onDetailChange?.(detailOpen)
  }, [detailOpen, props.onDetailChange])
  useEffect(() => {
    if (props.sourceAddRequest) setMode("marketplace")
  }, [props.sourceAddRequest])
  return (
    <div className="flex flex-col gap-5">
      {!detailOpen ? (
        <Tabs value={mode} onValueChange={setMode}>
          <TabsList
            className="extension-tabs bg-transparent"
            wrapperClassName="w-auto"
            aria-label="插件浏览方式"
          >
            <TabsTrigger value="marketplace">浏览市场</TabsTrigger>
            <TabsTrigger value="installed">已安装</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      <div hidden={mode !== "marketplace"}>
        <Marketplace {...props} notify={toast.success} onDetailChange={setMarketDetail} />
      </div>
      <div hidden={mode !== "installed"}>
        <InstalledPluginManager {...props} onDetailChange={setInstalledDetail} />
      </div>
    </div>
  )
}

type Approval = Extract<DesktopPluginArchiveImportResult, { status: "approval-required" }> & {
  source: "archive" | "git"
}
const displayName = (plugin: DesktopPluginInfo): string =>
  plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id
const needsAttention = (plugin: DesktopPluginInfo): boolean =>
  plugin.runtimeStatus.state === "failed" || plugin.runtimeStatus.state === "degraded"
const pluginRuntimeLabel = (plugin: DesktopPluginInfo): string => plugin.runtimeStatus.message
export function InstalledPluginManager({
  query,
  addRequest,
  gitAddRequest,
  refreshRequest,
  projectPath,
  notify,
  onDetailChange,
  onUse,
}: PluginManagerProps): React.JSX.Element {
  const api = window.desktop?.plugins
  const [snapshot, setSnapshot] = useState<DesktopPluginSnapshot | null>(null)
  const [loading, setLoading] = useState(Boolean(api))
  const [busy, setBusy] = useState(Boolean(api))
  const [filter, setFilter] = useState("all")
  const [detailId, setDetailId] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [removal, setRemoval] = useState<{ id: string; name: string } | null>(null)
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [gitDialogOpen, setGitDialogOpen] = useState(false)
  const [gitUrl, setGitUrl] = useState("")
  const [gitRef, setGitRef] = useState("")
  const [queuedImport, setQueuedImport] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const loadId = useRef(0)
  const previousRefresh = useRef(refreshRequest)
  const previousAdd = useRef(0)
  const previousGitAdd = useRef(0)
  const cancelledSelection = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  function reportFeedback(
    message: string,
    options: { details?: DesktopPluginArchiveFailureDetail[]; destructive?: boolean } = {}
  ): void {
    const description = options.details?.length
      ? options.details.map((detail) => detail.code).join("；")
      : undefined
    if (options.destructive) toast.error(message, description)
    else toast.success(message, description)
  }
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
        if (!cancelled) reportFeedback(errorText(cause), { destructive: true })
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
    result: DesktopPluginArchiveImportResult | DesktopPluginArchiveConfirmResult,
    source: Approval["source"] = "archive"
  ): void {
    if (result.status === "cancelled") return
    if (result.status === "approval-required") {
      cancelledSelection.current = null
      setApproval({ ...result, source })
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
      reportFeedback(result.message, { details: result.details })
      return
    }
    reportFeedback(result.message || "导入插件失败，请重试。", {
      details: result.details,
      destructive: true,
    })
  }
  async function importArchive(): Promise<void> {
    if (!api || lock.current) return
    lock.current = true
    setBusy(true)
    try {
      applyImportResult(
        await api.importArchive({
          cwd: projectPath,
        })
      )
    } catch {
      if (mounted.current) reportFeedback("导入插件失败，请重试。", { destructive: true })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function confirmArchive(): Promise<void> {
    if (!api || !approval || lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const result = await (approval.source === "git" ? api.confirmGit : api.confirmArchive)({
        cwd: projectPath,
        selectionId: approval.selectionId,
      })
      if (!mounted.current) return
      setApproval(null)
      applyImportResult(result)
    } catch {
      if (mounted.current) reportFeedback("导入插件失败，请重试。", { destructive: true })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function cancelArchive(): Promise<void> {
    if (!api || !approval || busy || cancelledSelection.current === approval.selectionId) return
    cancelledSelection.current = approval.selectionId
    const selectionId = approval.selectionId
    const source = approval.source
    setApproval(null)
    try {
      await (source === "git" ? api.cancelGit : api.cancelArchive)({ selectionId })
    } catch {
      if (mounted.current) reportFeedback("取消导入失败，请重试。", { destructive: true })
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
    if (!gitAddRequest || gitAddRequest === previousGitAdd.current) return
    previousGitAdd.current = gitAddRequest
    setGitDialogOpen(true)
  }, [gitAddRequest])
  async function importGit(): Promise<void> {
    if (!api || lock.current) return
    const url = gitUrl.trim()
    const ref = gitRef.trim()
    if (!url) {
      reportFeedback("请输入 Git 地址。", { destructive: true })
      return
    }
    lock.current = true
    setBusy(true)
    try {
      setGitDialogOpen(false)
      applyImportResult(
        await api.importGit({
          cwd: projectPath,
          url,
          ...(ref ? { ref } : {}),
        }),
        "git"
      )
    } catch {
      if (mounted.current) reportFeedback("从 Git 安装插件失败，请重试。", { destructive: true })
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (refreshRequest === previousRefresh.current || !api || busy || lock.current) return
    previousRefresh.current = refreshRequest
    lock.current = true
    setBusy(true)
    void api
      .snapshot({ cwd: projectPath })
      .then((value) => {
        if (mounted.current) {
          setSnapshot(value)
          notify("插件列表已刷新。")
        }
      })
      .catch((cause) => {
        if (mounted.current) reportFeedback(errorText(cause), { destructive: true })
      })
      .finally(() => {
        lock.current = false
        if (mounted.current) setBusy(false)
      })
  }, [api, notify, projectPath, refreshRequest, busy])
  async function mutate(plugin: DesktopPluginInfo, uninstall = false): Promise<void> {
    if (!api || lock.current || plugin.scope === "managed") return
    lock.current = true
    setBusy(true)
    if (uninstall) setUninstallError(null)
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
        setManageOpen(false)
      }
      notify(`${displayName(plugin)} 已${uninstall ? "卸载" : plugin.enabled ? "禁用" : "启用"}。`)
    } catch (cause) {
      if (mounted.current) {
        const message = errorText(cause)
        if (uninstall) setUninstallError(message)
        reportFeedback(message, { destructive: true })
      }
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
        plugin.presentation?.description,
        plugin.sourceFormat
      ) &&
      (filter === "all" || (filter === "enabled" ? plugin.enabled : needsAttention(plugin)))
  )
  const detail = plugins.find((plugin) => plugin.identity.id === detailId) ?? null
  const detailOpen = Boolean(detail)
  useEffect(() => {
    onDetailChange?.(detailOpen)
  }, [detailOpen, onDetailChange])
  return (
    <div className="flex flex-col gap-9">
      {detail ? (
        <PluginDetail
          key={detail.identity.id}
          plugin={detail}
          onUse={onUse}
          onBack={() => {
            setDetailId(null)
            setManageOpen(false)
          }}
          onManage={() => setManageOpen(true)}
        />
      ) : (
        <>
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
                        <ExtensionIcon name={displayName(plugin)} src={plugin.presentation?.icon} />
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
              <Tabs
                value={filter}
                onValueChange={setFilter}
                className="flex min-w-0 flex-col gap-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="plugin-list-title" className="text-sm font-medium">
                    我的插件
                  </h2>
                  <TabsList
                    className="extension-tabs bg-transparent"
                    wrapperClassName="w-auto"
                    aria-label="插件状态"
                  >
                    <TabsTrigger value="all" aria-label="全部">
                      全部
                    </TabsTrigger>
                    <TabsTrigger value="enabled" aria-label="已启用">
                      已启用
                    </TabsTrigger>
                    <TabsTrigger value="attention" aria-label="需处理">
                      需处理
                    </TabsTrigger>
                  </TabsList>
                </div>
                <Separator />
                <TabsContent value={filter} className="mt-0">
                  {visiblePlugins.length ? (
                    <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                      {visiblePlugins.map((plugin) => (
                        <ExtensionRow
                          key={plugin.identity.id}
                          name={displayName(plugin)}
                          icon={plugin.presentation?.icon}
                          description={
                            plugin.presentation?.description ||
                            `${plugin.identity.version} · ${plugin.scope === "managed" ? "由组织管理" : "个人安装"} · ${pluginRuntimeLabel(plugin)}`
                          }
                          status={
                            plugin.presentation?.description
                              ? pluginRuntimeLabel(plugin)
                              : undefined
                          }
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
                                    <DropdownMenuItem
                                      onClick={() => setDetailId(plugin.identity.id)}
                                    >
                                      查看详情
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={busy || plugin.scope === "managed"}
                                      variant="destructive"
                                      onClick={() =>
                                        setRemoval({
                                          id: plugin.identity.id,
                                          name: displayName(plugin),
                                        })
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
                </TabsContent>
              </Tabs>
            </section>
          ) : null}
        </>
      )}
      <PluginDetailsDialog
        error=""
        plugin={manageOpen ? detail : null}
        onOpenChange={(open) => !open && setManageOpen(false)}
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
      <Dialog
        open={gitDialogOpen}
        onOpenChange={(open) => {
          if (!busy) setGitDialogOpen(open)
        }}
      >
        <DialogContent className="gap-5 p-6 sm:max-w-lg">
          <DialogHeader className="pr-8">
            <DialogTitle>从 Git 安装插件</DialogTitle>
            <DialogDescription>
              输入 Native Plugin 仓库地址；branch、tag 或 commit 可不填。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              value={gitUrl}
              disabled={busy || !api}
              placeholder="https://github.com/acme/plugin.git"
              aria-label="Git 插件地址"
              onChange={(event) => setGitUrl(event.target.value)}
            />
            <Input
              value={gitRef}
              disabled={busy || !api}
              placeholder="branch / tag / commit，可空"
              aria-label="Git ref"
              onChange={(event) => setGitRef(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setGitDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={busy || !api || !gitUrl.trim()} onClick={() => void importGit()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(removal)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRemoval(null)
            setUninstallError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载插件 {removal?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              将移除插件安装记录与缓存。本地链接插件的源目录不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {uninstallError ? (
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
              {uninstallError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
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
            <AlertDialogDescription>{approval?.replacementRequired ? "将替换现有插件并更换安装来源，请确认此操作及以下权限。" : "该插件需要以下权限才能正常工作。"}</AlertDialogDescription>
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
