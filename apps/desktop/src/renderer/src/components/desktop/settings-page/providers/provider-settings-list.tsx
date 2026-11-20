import {
  KeyRound,
  Link2,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  Unplug,
} from "lucide-react"
import { useRef, useState } from "react"
import { Input } from "@renderer/components/motion/input"
import {
  OverflowActions,
  type OverflowActionItem,
} from "@renderer/components/motion/overflow-actions"
import type * as React from "react"
import { Button } from "@renderer/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"
import type { DesktopProviderCredentialSource, DesktopProviderInfo } from "@shared/provider-types"
import { resolveProviderBrandIcon, type ProviderBrandIcon } from "./provider-brand-icons"

const localizedProviderNames: Record<string, string> = {
  zhipu: "智谱",
  zhipuai: "智谱",
  "zhipuai-coding-plan": "智谱 Coding Plan",
  zai: "智谱国际版",
  "zai-coding-plan": "智谱国际版 Coding Plan",
}

export function providerDisplayName(provider: DesktopProviderInfo): string {
  return localizedProviderNames[provider.name] ?? provider.displayName
}

export function ProviderList({
  connectedProviders,
  availableProviders,
  additionalProviderCount,
  busyProvider,
  onShowMore,
  onConnect,
  onDisconnect,
  onEditCustom,
  onRemoveCustom,
  verified,
  onTest,
}: {
  connectedProviders: DesktopProviderInfo[]
  availableProviders: DesktopProviderInfo[]
  additionalProviderCount: number
  busyProvider: string | null
  onShowMore: () => void
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
  verified: Record<string, { model: string; checkedAt: number }>
  onTest: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <ProviderGroup
        label="已配置"
        providers={connectedProviders}
        verified={verified}
        onTest={onTest}
        emptyText="还没有配置供应商。"
        busyProvider={busyProvider}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onEditCustom={onEditCustom}
        onRemoveCustom={onRemoveCustom}
      />
      <ProviderGroup
        label="可连接"
        providers={availableProviders}
        verified={verified}
        onTest={onTest}
        emptyText={additionalProviderCount === 0 ? "没有其他可连接的供应商。" : undefined}
        busyProvider={busyProvider}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onEditCustom={onEditCustom}
        onRemoveCustom={onRemoveCustom}
      >
        {additionalProviderCount > 0 && (
          <Button type="button" variant="ghost" shape="pill" onClick={onShowMore}>
            更多供应商（{additionalProviderCount}）
          </Button>
        )}
      </ProviderGroup>
    </div>
  )
}

export function MoreProvidersDialog({
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
      <DialogContent className="flex max-h-[min(38rem,calc(100dvh-2rem))] flex-col gap-3 sm:max-w-lg [&>[data-slot=dialog-close]]:rounded-full">
        <DialogHeader>
          <DialogTitle>更多供应商</DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          onChange={onQueryChange}
          placeholder={`搜索 ${totalCount} 个供应商`}
          aria-label="搜索更多供应商"
          leftIcon={<Search aria-hidden="true" />}
          classNames={{ input: "pl-9" }}
        />
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
  providers,
  emptyText,
  busyProvider,
  onConnect,
  onDisconnect,
  onEditCustom,
  onRemoveCustom,
  verified,
  onTest,
  children,
}: {
  label: string
  providers: DesktopProviderInfo[]
  emptyText?: string
  busyProvider: string | null
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
  verified: Record<string, { model: string; checkedAt: number }>
  onTest: (provider: DesktopProviderInfo) => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
      <div className="divide-y divide-border/70 border-t border-border/70">
        {providers.length === 0
          ? emptyText && <p className="py-3 text-xs text-muted-foreground">{emptyText}</p>
          : providers.map((provider) => (
              <ProviderRow
                key={provider.name}
                provider={provider}
                busy={busyProvider === provider.name}
                locked={busyProvider !== null}
                onConnect={() => onConnect(provider)}
                onDisconnect={() => onDisconnect(provider)}
                onEditCustom={() => onEditCustom(provider)}
                onRemoveCustom={() => onRemoveCustom(provider)}
                verification={verified[provider.name]}
                onTest={() => onTest(provider)}
              />
            ))}
      </div>
      {children}
    </section>
  )
}

function ProviderRow({
  provider,
  busy,
  locked,
  onConnect,
  onDisconnect,
  onEditCustom,
  onRemoveCustom,
  verification,
  onTest,
}: {
  provider: DesktopProviderInfo
  busy: boolean
  locked: boolean
  onConnect: () => void
  onDisconnect: () => void
  onEditCustom: () => void
  onRemoveCustom: () => void
  verification?: { model: string; checkedAt: number }
  onTest: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const actions: OverflowActionItem[] = []
  const name = providerDisplayName(provider)
  if (provider.connected && provider.name !== "codex" && provider.models.length > 0)
    actions.push({
      id: "test",
      label: "测试连接",
      icon: <Link2 className="size-4" aria-hidden="true" />,
      disabled: locked,
      onClick: onTest,
      ariaLabel: `测试 ${name} 连接`,
    })
  if (provider.credentialSource === "credentials")
    actions.push({
      id: "credentials",
      label: "更新密钥",
      icon: <KeyRound className="size-4" aria-hidden="true" />,
      disabled: locked,
      onClick: onConnect,
      ariaLabel: `更新 ${name} 密钥`,
    })
  if (provider.credentialSource === "credentials" && !provider.custom)
    actions.push({
      id: "disconnect",
      label: "断开",
      icon: <Unplug className="size-4" aria-hidden="true" />,
      disabled: locked,
      onClick: onDisconnect,
      ariaLabel: `断开 ${name}`,
    })
  if (provider.custom)
    actions.push(
      {
        id: "edit",
        label: "编辑",
        icon: <Pencil className="size-4" aria-hidden="true" />,
        disabled: locked,
        onClick: onEditCustom,
        ariaLabel: `编辑 ${provider.displayName}`,
      },
      {
        id: "delete",
        label: "删除",
        icon: <Trash2 className="size-4 text-destructive" aria-hidden="true" />,
        disabled: locked,
        onClick: onRemoveCustom,
        ariaLabel: `删除 ${provider.displayName}`,
      }
    )
  const status = provider.connected
    ? [
        sourceLabel(provider.credentialSource, provider.credentialLabel),
        verification
          ? `模型列表已验证 · ${new Date(verification.checkedAt).toLocaleTimeString()}`
          : "未验证",
      ]
    : []
  if (provider.active) status.push("默认连接")
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon provider={provider} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium break-words">{name}</h4>
          {status.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">{status.join(" · ")}</p>
          )}
          {provider.custom && provider.baseUrl && (
            <p className="truncate text-xs text-muted-foreground" title={provider.baseUrl}>
              {provider.baseUrl}
            </p>
          )}
        </div>
      </div>
      <div
        ref={actionsRef}
        className="flex max-w-full shrink-0 items-center justify-end gap-2"
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) {
            setExpanded(false)
            actionsRef.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus()
            event.stopPropagation()
          }
        }}
      >
        {busy ? (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground"
            aria-label={`正在处理 ${name}`}
          />
        ) : null}
        {!provider.connected && provider.credentialSource !== "credentials" ? (
          <Button
            type="button"
            shape="pill"
            variant="outline"
            title={`连接 ${name}`}
            aria-label={`连接 ${name}`}
            disabled={locked}
            onClick={onConnect}
          >
            连接
          </Button>
        ) : null}
        {actions.length ? (
          <OverflowActions
            primaryActions={actions.filter(
              (action) => action.id === "test" || action.id === "credentials"
            )}
            overflowActions={actions.filter(
              (action) => action.id !== "test" && action.id !== "credentials"
            )}
            expanded={expanded}
            onExpandedChange={setExpanded}
            collapseOnAction
            size="sm"
            openLabel={`更多 ${name} 操作`}
            closeLabel={`收起 ${name} 操作`}
            className="max-w-full overflow-x-auto"
            classNames={{
              action: "w-8 gap-0 px-0 disabled:pointer-events-auto",
              label: "sr-only",
              toggle: cn(
                "bg-muted text-muted-foreground hover:text-foreground",
                !actions.some((action) => action.id !== "test" && action.id !== "credentials") &&
                  "hidden"
              ),
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function ProviderIcon({
  provider,
  compact = false,
}: {
  provider?: DesktopProviderInfo
  compact?: boolean
}): React.JSX.Element {
  const BrandIcon = provider ? resolveProviderBrandIcon(provider.name) : undefined

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center text-muted-foreground",
        compact ? "size-5 [&_svg]:size-3.5" : "size-8 [&_svg]:size-5"
      )}
    >
      {BrandIcon ? <ProviderBrandMark icon={BrandIcon} /> : <Sparkles aria-hidden="true" />}
    </span>
  )
}

function ProviderBrandMark({ icon: Icon }: { icon: ProviderBrandIcon }): React.JSX.Element {
  return <Icon aria-hidden="true" />
}

function sourceLabel(source: DesktopProviderCredentialSource, label?: string): string {
  if (source === "credentials") return label ?? "API 密钥"
  if (source === "environment") return label ? `环境变量 · ${label}` : "环境变量"
  if (source === "subscription") return label ? `开发工具订阅 · ${label}` : "开发工具订阅"
  if (source === "local") return "本地服务"
  if (source === "configured") return label ?? "已配置"
  return "未连接"
}
