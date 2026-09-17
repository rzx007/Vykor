import {
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
import { Alert, AlertAction, AlertDescription } from "@renderer/components/ui/alert"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  DesktopProviderCredentialSource,
  DesktopCustomProviderInput,
  DesktopProviderInfo,
  DesktopProviderSnapshot,
} from "@shared/provider-types"
import { CatalogProviderHeadersDialog } from "./catalog-provider-headers-dialog"
import { scheduleProviderNoticeDismissal } from "./provider-feedback"
import {
  ProviderConnectionDialog,
  type ProviderConnectionSubmitValue,
} from "./provider-connection-dialog"
import { CustomProviderDialog } from "./custom-provider-dialog"
import { resolveProviderBrandIcon, type ProviderBrandIcon } from "./provider-brand-icons"

const popularProviderNames = [
  "openai",
  "anthropic",
  "deepseek",
  "openrouter",
  "gemini",
  "dashscope",
  "zhipu",
  "zhipuai-coding-plan",
  "moonshot",
  "minimax",
  "xiaomi",
]

const providerDescriptions: Record<string, string> = {
  openai: "GPT 系列模型",
  anthropic: "Claude 系列模型",
  deepseek: "DeepSeek 对话与推理模型",
  openrouter: "通过一个 API 使用多个模型",
  gemini: "Google Gemini 系列模型",
  dashscope: "阿里云百炼与通义千问模型",
  moonshot: "Moonshot 与 Kimi 系列模型",
  minimax: "MiniMax 系列模型",
  zhipu: "智谱 GLM 系列模型",
  "zhipuai-coding-plan": "智谱 Coding Plan 专属模型",
  xiaomi: "小米 MiMo 系列模型",
  groq: "Groq 高速推理服务",
  mistral: "Mistral 与 Codestral 模型",
}

const localizedProviderNames: Record<string, string> = {
  zhipu: "智谱",
  zhipuai: "智谱",
  "zhipuai-coding-plan": "智谱 Coding Plan",
  zai: "智谱国际版",
  "zai-coding-plan": "智谱国际版 Coding Plan",
}

function providerDisplayName(provider: DesktopProviderInfo): string {
  return localizedProviderNames[provider.name] ?? provider.displayName
}

export function ProviderSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopProviderSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [catalogHeadersTarget, setCatalogHeadersTarget] = useState<DesktopProviderInfo | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [moreProvidersOpen, setMoreProvidersOpen] = useState(false)
  const [providerQuery, setProviderQuery] = useState("")
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [customEditTarget, setCustomEditTarget] = useState<DesktopProviderInfo | null>(null)
  const [customRemoveTarget, setCustomRemoveTarget] = useState<DesktopProviderInfo | null>(null)
  const mutationInFlight = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      setSnapshot(await window.desktop.providers.snapshot())
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.desktop.providers
      .snapshot()
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
  }, [])

  useEffect(() => {
    if (!message) return
    return scheduleProviderNoticeDismissal(() => setMessage(null), 4_000)
  }, [message])

  useEffect(() => {
    if (!error) return
    return scheduleProviderNoticeDismissal(() => setError(null), 6_000)
  }, [error])

  const connectedProviders = useMemo(
    () => snapshot?.providers.filter((provider) => provider.connected) ?? [],
    [snapshot]
  )
  const availableProviders = useMemo(() => {
    const providers =
      snapshot?.providers.filter((provider) => !provider.connected && provider.name !== "codex") ??
      []
    return [...providers].sort((left, right) => {
      const leftIndex = popularProviderNames.indexOf(left.name)
      const rightIndex = popularProviderNames.indexOf(right.name)
      if (leftIndex === -1 && rightIndex === -1) {
        return left.displayName.localeCompare(right.displayName)
      }
      if (leftIndex === -1) return 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
  }, [snapshot])
  const visibleAvailableProviders = useMemo(
    () =>
      popularProviderNames.flatMap((name) => {
        const provider = availableProviders.find((item) => item.name === name)
        return provider ? [provider] : []
      }),
    [availableProviders]
  )
  const additionalAvailableProviders = useMemo(
    () => availableProviders.filter((provider) => !popularProviderNames.includes(provider.name)),
    [availableProviders]
  )
  const filteredAdditionalProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase()
    if (!query) return additionalAvailableProviders
    return additionalAvailableProviders.filter((provider) =>
      `${providerDisplayName(provider)} ${provider.displayName} ${provider.name}`
        .toLocaleLowerCase()
        .includes(query)
    )
  }, [additionalAvailableProviders, providerQuery])
  const activeProvider = snapshot?.providers.find((provider) => provider.active)

  const runMutation = async (
    providerName: string,
    operation: () => Promise<DesktopProviderSnapshot>,
    successMessage: string
  ): Promise<boolean> => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setBusyProvider(providerName)
    setError(null)
    setMessage(null)
    try {
      const nextSnapshot = await operation()
      setSnapshot(nextSnapshot)
      try {
        await useDesktopSessionStore.getState().refreshBootstrap()
        setSnapshot(await window.desktop.providers.snapshot())
      } catch (refreshError) {
        setError(`供应商设置已生效，但对话模型刷新失败：${errorMessage(refreshError)}`)
        return true
      }
      setMessage(successMessage)
      return true
    } catch (mutationError) {
      setError(errorMessage(mutationError))
      return false
    } finally {
      mutationInFlight.current = false
      setBusyProvider(null)
    }
  }

  const activate = (provider: DesktopProviderInfo): void => {
    void runMutation(
      provider.name,
      () => window.desktop.providers.activate({ provider: provider.name }),
      `已将 ${providerDisplayName(provider)} 设为当前供应商。`
    )
  }

  const connect = (value: ProviderConnectionSubmitValue): void => {
    if (!connectTarget || !value.apiKey.trim() || busyProvider) return
    const target = connectTarget
    void runMutation(
      target.name,
      () =>
        window.desktop.providers.connect({
          provider: target.name,
          apiKey: value.apiKey,
          ...(value.headers !== undefined ? { headers: value.headers } : {}),
          setActive: value.setActive,
        }),
      `已连接 ${providerDisplayName(target)}。`
    ).then((succeeded) => {
      if (!succeeded) return
      setConnectTarget(null)
    })
  }

  const openConnectDialog = (provider: DesktopProviderInfo): void => {
    setMoreProvidersOpen(false)
    setProviderQuery("")
    setConnectTarget(provider)
  }

  const saveCatalogHeaders = (headers: Record<string, string>): void => {
    if (!catalogHeadersTarget || busyProvider) return
    const target = catalogHeadersTarget
    void runMutation(
      target.name,
      () =>
        window.desktop.providers.updateCatalogHeaders({
          provider: target.name,
          headers,
        }),
      `已更新 ${providerDisplayName(target)} 的请求头。`
    ).then((succeeded) => {
      if (!succeeded) return
      setCatalogHeadersTarget(null)
    })
  }

  const disconnect = (): void => {
    if (!disconnectTarget || busyProvider) return
    const target = disconnectTarget
    void runMutation(
      target.name,
      () => window.desktop.providers.disconnect({ provider: target.name }),
      `已断开 ${providerDisplayName(target)}。`
    ).then((succeeded) => succeeded && setDisconnectTarget(null))
  }

  const saveCustomProvider = (value: DesktopCustomProviderInput, setActive: boolean): void => {
    const target = customEditTarget
    void runMutation(
      target?.name ?? value.id,
      () =>
        target
          ? window.desktop.providers.updateCustom({ provider: target.name, value })
          : window.desktop.providers.createCustom({ ...value, setActive }),
      target ? `已更新 ${value.displayName}。` : `已添加 ${value.displayName}。`
    ).then((succeeded) => {
      if (!succeeded) return
      setCustomDialogOpen(false)
      setCustomEditTarget(null)
    })
  }

  const removeCustomProvider = (): void => {
    if (!customRemoveTarget || busyProvider) return
    const target = customRemoveTarget
    void runMutation(
      target.name,
      () => window.desktop.providers.removeCustom({ provider: target.name }),
      `已删除 ${target.displayName}。`
    ).then((succeeded) => succeeded && setCustomRemoveTarget(null))
  }

  if (loading && !snapshot) return <ProviderSettingsSkeleton />

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert variant="destructive" aria-live="assertive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="关闭错误提示"
              onClick={() => setError(null)}
            >
              <X data-icon="inline-start" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {message ? (
        <Alert role="status" aria-live="polite">
          <CircleCheck />
          <AlertDescription>{message}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="关闭成功提示"
              onClick={() => setMessage(null)}
            >
              <X data-icon="inline-start" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <CurrentProviderCard provider={activeProvider} activeModel={snapshot?.activeModel} />

      <section className="flex flex-col gap-4" aria-labelledby="provider-heading">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="provider-heading" className="font-heading text-base tracking-tight">
              供应商
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              统一管理 API 密钥、本地服务和自动检测到的开发工具订阅。
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重新检测供应商"
                  disabled={loading}
                  onClick={() => void load()}
                />
              }
            >
              <RefreshCw data-icon="inline-start" className={cn(loading && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>重新检测供应商</TooltipContent>
          </Tooltip>
        </div>
        <ProviderListCard
          connectedProviders={connectedProviders}
          availableProviders={visibleAvailableProviders}
          additionalProviderCount={additionalAvailableProviders.length}
          busyProvider={busyProvider}
          onShowMore={() => setMoreProvidersOpen(true)}
          onActivate={activate}
          onConnect={openConnectDialog}
          onDisconnect={setDisconnectTarget}
          onEditCatalogHeaders={setCatalogHeadersTarget}
          onAddCustom={() => {
            setCustomEditTarget(null)
            setCustomDialogOpen(true)
          }}
          onEditCustom={(provider) => {
            setCustomEditTarget(provider)
            setCustomDialogOpen(true)
          }}
          onRemoveCustom={setCustomRemoveTarget}
        />
      </section>

      <MoreProvidersDialog
        open={moreProvidersOpen}
        query={providerQuery}
        providers={filteredAdditionalProviders}
        totalCount={additionalAvailableProviders.length}
        busyProvider={busyProvider}
        onOpenChange={(open) => {
          setMoreProvidersOpen(open)
          if (!open) setProviderQuery("")
        }}
        onQueryChange={setProviderQuery}
        onConnect={openConnectDialog}
      />

      <CustomProviderDialog
        open={customDialogOpen}
        provider={customEditTarget ?? undefined}
        busy={busyProvider !== null}
        onOpenChange={(open) => {
          setCustomDialogOpen(open)
          if (!open) setCustomEditTarget(null)
        }}
        onSubmit={saveCustomProvider}
      />

      <ProviderConnectionDialog
        open={connectTarget !== null}
        provider={connectTarget}
        busy={busyProvider !== null}
        onOpenChange={(open) => {
          if (open || busyProvider) return
          setConnectTarget(null)
        }}
        onSubmit={connect}
      />

      {catalogHeadersTarget ? (
        <CatalogProviderHeadersDialog
          provider={catalogHeadersTarget}
          busy={busyProvider !== null}
          onOpenChange={(open) => {
            if (open || busyProvider) return
            setCatalogHeadersTarget(null)
          }}
          onSubmit={saveCatalogHeaders}
        />
      ) : null}

      <AlertDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => !open && !busyProvider && setDisconnectTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开 {disconnectTarget?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>
              这会删除 OpenHarness 保存的该供应商凭证，不会影响供应商网站上的账户或订阅。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyProvider !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyProvider !== null}
              onClick={disconnect}
            >
              {busyProvider ? "断开中..." : "断开连接"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={customRemoveTarget !== null}
        onOpenChange={(open) => !open && !busyProvider && setCustomRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {customRemoveTarget?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>
              这会移除自定义连接、模型和 OpenHarness 保存的对应凭证。该操作不会影响远端服务。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyProvider !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyProvider !== null}
              onClick={removeCustomProvider}
            >
              {busyProvider ? "删除中..." : "删除供应商"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CurrentProviderCard({
  provider,
  activeModel,
}: {
  provider?: DesktopProviderInfo
  activeModel?: string
}): React.JSX.Element {
  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b bg-muted/30">
        <CardTitle>当前供应商</CardTitle>
        <CardDescription>新会话默认使用的模型服务与认证来源。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          <ProviderIcon provider={provider} emphasized />
          <div className="min-w-0">
            <p className="truncate font-heading text-base font-semibold">
              {provider?.displayName ?? "尚未选择供应商"}
            </p>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {activeModel ?? "未选择默认模型"}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {provider
                ? sourceLabel(provider.credentialSource, provider.credentialLabel)
                : "连接供应商后即可开始使用"}
            </p>
          </div>
        </div>
        {provider?.connected ? (
          <Badge variant="secondary">正在使用</Badge>
        ) : provider ? (
          <Badge variant="destructive">认证不可用</Badge>
        ) : (
          <Badge variant="outline">未配置</Badge>
        )}
      </CardContent>
    </Card>
  )
}

function ProviderListCard({
  connectedProviders,
  availableProviders,
  additionalProviderCount,
  busyProvider,
  onShowMore,
  onActivate,
  onConnect,
  onDisconnect,
  onEditCatalogHeaders,
  onAddCustom,
  onEditCustom,
  onRemoveCustom,
}: {
  connectedProviders: DesktopProviderInfo[]
  availableProviders: DesktopProviderInfo[]
  additionalProviderCount: number
  busyProvider: string | null
  onShowMore: () => void
  onActivate: (provider: DesktopProviderInfo) => void
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
  onEditCatalogHeaders: (provider: DesktopProviderInfo) => void
  onAddCustom: () => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <Card className="py-0 shadow-xs">
      <CardHeader className="sr-only">
        <CardTitle>供应商列表</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ProviderGroup
          label="已连接"
          description="凭证仅显示来源，不会在页面中返回密钥内容。"
          providers={connectedProviders}
          emptyText="还没有检测到已连接的供应商。"
          busyProvider={busyProvider}
          onActivate={onActivate}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onEditCatalogHeaders={onEditCatalogHeaders}
          onEditCustom={onEditCustom}
          onRemoveCustom={onRemoveCustom}
        />
        <Separator />
        <ProviderGroup
          label="可连接"
          description="选择模型服务并保存 API 密钥。"
          providers={availableProviders}
          emptyText="所有内置供应商都已连接。"
          busyProvider={busyProvider}
          onActivate={onActivate}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onEditCatalogHeaders={onEditCatalogHeaders}
          onEditCustom={onEditCustom}
          onRemoveCustom={onRemoveCustom}
        />
        {additionalProviderCount > 0 ? (
          <>
            <Separator />
            <div className="flex justify-center px-6 py-2.5">
              <Button type="button" variant="link" size="sm" onClick={onShowMore}>
                查看更多供应商（{additionalProviderCount}）
              </Button>
            </div>
          </>
        ) : null}
        <Separator />
        <div className="flex items-center justify-between gap-4 bg-muted/20 px-6 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-foreground/10 [&_svg]:size-4">
              <Plus />
            </span>
            <div className="min-w-0">
              <p className="font-heading text-sm font-semibold">自定义供应商</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                添加 Ollama、vLLM 或其他 OpenAI 兼容接口
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busyProvider !== null}
            onClick={onAddCustom}
          >
            <Plus data-icon="inline-start" />
            添加
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MoreProvidersDialog({
  open,
  query,
  providers,
  totalCount,
  busyProvider,
  onOpenChange,
  onQueryChange,
  onConnect,
}: {
  open: boolean
  query: string
  providers: DesktopProviderInfo[]
  totalCount: number
  busyProvider: string | null
  onOpenChange: (open: boolean) => void
  onQueryChange: (query: string) => void
  onConnect: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(38rem,calc(100vh-2rem))] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>更多供应商</DialogTitle>
          <DialogDescription>选择供应商后填写 API Key，验证通过后才会保存。</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={`搜索 ${totalCount} 个供应商`}
            aria-label="搜索更多供应商"
            className="pl-9"
          />
        </div>
        <ScrollArea horizontal={false} className="min-h-0 flex-1 pr-2">
          {providers.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              没有找到匹配的供应商。
            </p>
          ) : (
            <div className="flex flex-col gap-0.5 px-1 py-1">
              {providers.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  disabled={busyProvider !== null}
                  className={cn(
                    "flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors outline-none",
                    "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                    "disabled:pointer-events-none disabled:opacity-50",
                    busyProvider === provider.name && "bg-muted"
                  )}
                  aria-label={`连接 ${providerDisplayName(provider)}`}
                  onClick={() => onConnect(provider)}
                >
                  <ProviderIcon provider={provider} compact />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {providerDisplayName(provider)}
                  </span>
                  {busyProvider === provider.name ? (
                    <LoaderCircle
                      aria-label="正在连接"
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function ProviderGroup({
  label,
  description,
  providers,
  emptyText,
  busyProvider,
  onActivate,
  onConnect,
  onDisconnect,
  onEditCatalogHeaders,
  onEditCustom,
  onRemoveCustom,
}: {
  label: string
  description: string
  providers: DesktopProviderInfo[]
  emptyText: string
  busyProvider: string | null
  onActivate: (provider: DesktopProviderInfo) => void
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
  onEditCatalogHeaders: (provider: DesktopProviderInfo) => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 bg-muted/20 px-6 py-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-sm font-semibold">{label}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">{providers.length}</Badge>
      </div>
      <div className="px-6">
        {providers.length === 0 ? (
          <p className="py-5 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          providers.map((provider, index) => (
            <div key={provider.name}>
              {index > 0 ? <Separator /> : null}
              <ProviderRow
                provider={provider}
                busy={busyProvider === provider.name}
                locked={busyProvider !== null}
                onActivate={() => onActivate(provider)}
                onConnect={() => onConnect(provider)}
                onDisconnect={() => onDisconnect(provider)}
                onEditCatalogHeaders={() => onEditCatalogHeaders(provider)}
                onEditCustom={() => onEditCustom(provider)}
                onRemoveCustom={() => onRemoveCustom(provider)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ProviderRow({
  provider,
  busy,
  locked,
  onActivate,
  onConnect,
  onDisconnect,
  onEditCatalogHeaders,
  onEditCustom,
  onRemoveCustom,
}: {
  provider: DesktopProviderInfo
  busy: boolean
  locked: boolean
  onActivate: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEditCatalogHeaders: () => void
  onEditCustom: () => void
  onRemoveCustom: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-16 flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="font-heading text-sm font-semibold">{providerDisplayName(provider)}</h3>
            {provider.connected ? (
              <Badge variant="outline">
                {sourceLabel(provider.credentialSource, provider.credentialLabel)}
              </Badge>
            ) : null}
            {provider.active ? (
              <Badge variant={provider.connected ? "secondary" : "destructive"}>
                {provider.connected ? "正在使用" : "认证不可用"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {provider.currentModel ??
              providerDescriptions[provider.name] ??
              (provider.custom
                ? provider.baseUrl
                : provider.source === "catalog"
                  ? "models.dev 目录供应商"
                  : "OpenHarness 内置供应商")}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {provider.active && provider.connected ? (
          <Button type="button" size="sm" variant="ghost" disabled>
            <CheckCircle2 data-icon="inline-start" />
            当前
          </Button>
        ) : provider.connected ? (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onActivate}>
            {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {busy ? "切换中..." : "设为当前"}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onConnect}>
            <Link2 data-icon="inline-start" />
            {provider.active ? "重新连接" : "连接"}
          </Button>
        )}
        {provider.source === "catalog" && provider.connected ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={onEditCatalogHeaders}
          >
            请求头
          </Button>
        ) : null}
        {provider.credentialSource === "credentials" && !provider.active && !provider.custom ? (
          <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onDisconnect}>
            断开
          </Button>
        ) : null}
        {provider.custom ? (
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`编辑 ${provider.displayName}`}
              disabled={locked}
              onClick={onEditCustom}
            >
              <Pencil data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`删除 ${provider.displayName}`}
              disabled={locked || provider.active}
              onClick={onRemoveCustom}
            >
              <Trash2 data-icon="inline-start" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function ProviderIcon({
  provider,
  emphasized = false,
  compact = false,
}: {
  provider?: DesktopProviderInfo
  emphasized?: boolean
  compact?: boolean
}): React.JSX.Element {
  const BrandIcon = provider ? resolveProviderBrandIcon(provider.name) : undefined

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground ring-1 ring-foreground/10",
        compact
          ? "size-5 rounded-sm bg-transparent ring-0 [&_svg]:size-3.5"
          : emphasized
            ? "size-12 shadow-xs [&_svg]:size-5"
            : "size-9 rounded-lg [&_svg]:size-4"
      )}
    >
      {BrandIcon ? <ProviderBrandMark icon={BrandIcon} /> : <Sparkles aria-hidden="true" />}
    </span>
  )
}

function ProviderBrandMark({ icon: Icon }: { icon: ProviderBrandIcon }): React.JSX.Element {
  return <Icon aria-hidden="true" />
}

function ProviderSettingsSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8" aria-label="正在加载供应商">
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}

function sourceLabel(source: DesktopProviderCredentialSource, label?: string): string {
  if (source === "credentials") return label ?? "API 密钥"
  if (source === "environment") return label ? `环境变量 · ${label}` : "环境变量"
  if (source === "subscription") return label ? `开发工具订阅 · ${label}` : "开发工具订阅"
  if (source === "local") return "本地服务"
  if (source === "configured") return label ?? "已配置"
  return "未连接"
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes("Cannot update authentication while session runs are active")) {
    return "当前有任务正在运行。请等待任务结束或停止任务后，再修改供应商认证。"
  }
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "")
}
