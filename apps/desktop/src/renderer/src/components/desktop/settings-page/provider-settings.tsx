import { RefreshCw } from "lucide-react"
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
import { Button } from "@renderer/components/ui/button"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { toast } from "@renderer/lib/toast"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  DesktopCustomProviderInput,
  DesktopProviderInfo,
  DesktopProviderSnapshot,
} from "@shared/provider-types"
import {
  ProviderConnectionDialog,
  type ProviderConnectionSubmitValue,
} from "./provider-connection-dialog"
import { CustomProviderDialog } from "./custom-provider-dialog"
import { MoreProvidersDialog, ProviderListCard, providerDisplayName } from "./provider-settings-list"

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

export function ProviderSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopProviderSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [moreProvidersOpen, setMoreProvidersOpen] = useState(false)
  const [providerQuery, setProviderQuery] = useState("")
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [customEditTarget, setCustomEditTarget] = useState<DesktopProviderInfo | null>(null)
  const [customRemoveTarget, setCustomRemoveTarget] = useState<DesktopProviderInfo | null>(null)
  const mutationInFlight = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSnapshot(await window.desktop.providers.snapshot())
    } catch (loadError) {
      toast.error(errorMessage(loadError))
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
        if (!cancelled) toast.error(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  const runMutation = async (
    providerName: string,
    operation: () => Promise<DesktopProviderSnapshot>,
    successMessage: string
  ): Promise<boolean> => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setBusyProvider(providerName)
    try {
      const nextSnapshot = await operation()
      setSnapshot(nextSnapshot)
      try {
        await useDesktopSessionStore.getState().refreshBootstrap()
        setSnapshot(await window.desktop.providers.snapshot())
      } catch (refreshError) {
        toast.error(`供应商设置已生效，但对话模型刷新失败：${errorMessage(refreshError)}`)
        return true
      }
      toast.success(successMessage)
      return true
    } catch (mutationError) {
      toast.error(errorMessage(mutationError))
      return false
    } finally {
      mutationInFlight.current = false
      setBusyProvider(null)
    }
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
          setActive: false,
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

  const disconnect = (): void => {
    if (!disconnectTarget || busyProvider) return
    const target = disconnectTarget
    void runMutation(
      target.name,
      () => window.desktop.providers.disconnect({ provider: target.name }),
      `已断开 ${providerDisplayName(target)}。`
    ).then((succeeded) => succeeded && setDisconnectTarget(null))
  }

  const saveCustomProvider = (value: DesktopCustomProviderInput): void => {
    const target = customEditTarget
    void runMutation(
      target?.name ?? value.id,
      () =>
        target
          ? window.desktop.providers.updateCustom({ provider: target.name, value })
          : window.desktop.providers.createCustom({ ...value, setActive: false }),
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
          onConnect={openConnectDialog}
          onDisconnect={setDisconnectTarget}
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

      <AlertDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => !open && !busyProvider && setDisconnectTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开 {disconnectTarget?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>
              这会删除 Vykor 保存的该供应商凭证，不会影响供应商网站上的账户或订阅。
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
              这会移除自定义连接、模型和 Vykor 保存的对应凭证。该操作不会影响远端服务。
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

function ProviderSettingsSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8" aria-label="正在加载供应商">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes("Cannot update authentication while session runs are active")) {
    return "当前有任务正在运行。请等待任务结束或停止任务后，再修改供应商认证。"
  }
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "")
}
