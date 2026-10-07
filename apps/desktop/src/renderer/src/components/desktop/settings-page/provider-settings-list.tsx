import { Link2, LoaderCircle, Pencil, Plus, Search, Sparkles, Trash2 } from "lucide-react"
import type * as React from "react"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import { cn } from "@renderer/lib/utils"
import type { DesktopProviderCredentialSource, DesktopProviderInfo } from "@shared/provider-types"
import { resolveProviderBrandIcon, type ProviderBrandIcon } from "./provider-brand-icons"

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

export function providerDisplayName(provider: DesktopProviderInfo): string {
  return localizedProviderNames[provider.name] ?? provider.displayName
}

export function ProviderListCard({
  connectedProviders,
  availableProviders,
  additionalProviderCount,
  busyProvider,
  onShowMore,
  onConnect,
  onDisconnect,
  onAddCustom,
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
  onAddCustom: () => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
  verified: Record<string, { model: string; checkedAt: number }>
  onTest: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <Card className="py-0 shadow-xs">
      <CardHeader className="sr-only">
        <CardTitle>供应商列表</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ProviderGroup
          label="已配置"
          description="检测到认证或本地配置；测试通过才标为已验证。凭据值不会返回页面。"
          providers={connectedProviders}
          verified={verified}
          onTest={onTest}
          emptyText="还没有检测到已连接的供应商。"
          busyProvider={busyProvider}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onEditCustom={onEditCustom}
          onRemoveCustom={onRemoveCustom}
        />
        <Separator />
        <ProviderGroup
          label="可连接"
          description="选择模型服务并保存 API 密钥。"
          providers={availableProviders}
          verified={verified}
          onTest={onTest}
          emptyText="所有内置供应商都已连接。"
          busyProvider={busyProvider}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
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
      <DialogContent className="flex max-h-[min(38rem,calc(100vh-2rem))] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>更多供应商</DialogTitle>
          <DialogDescription>保存 API Key 时会请求服务的模型列表接口验证；上游可能按自己的规则收费。</DialogDescription>
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
  onConnect,
  onDisconnect,
  onEditCustom,
  onRemoveCustom,
  verified,
  onTest,
}: {
  label: string
  description: string
  providers: DesktopProviderInfo[]
  emptyText: string
  busyProvider: string | null
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
  onEditCustom: (provider: DesktopProviderInfo) => void
  onRemoveCustom: (provider: DesktopProviderInfo) => void
  verified: Record<string, { model: string; checkedAt: number }>
  onTest: (provider: DesktopProviderInfo) => void
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
                onConnect={() => onConnect(provider)}
                onDisconnect={() => onDisconnect(provider)}
                onEditCustom={() => onEditCustom(provider)}
                onRemoveCustom={() => onRemoveCustom(provider)}
                verification={verified[provider.name]}
                onTest={() => onTest(provider)}
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
            {provider.active ? <Badge variant="outline">默认连接</Badge> : null}
            {provider.connected ? <span className="text-xs text-muted-foreground">{verification ? `已验证模型列表 · ${new Date(verification.checkedAt).toLocaleTimeString()}` : "已配置，未验证"}</span> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {providerDescriptions[provider.name] ??
              (provider.custom
                ? provider.baseUrl
                : provider.source === "catalog"
                  ? "models.dev 目录供应商"
                  : "Vykor 内置供应商")}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {provider.connected && <Button type="button" size="sm" variant="ghost" disabled={locked || !provider.models.length || provider.name === "codex"} title={provider.name === "codex" ? "订阅适配器未提供独立模型列表验证接口" : !provider.models.length ? "供应商没有列出可测试模型" : "向服务发送模型列表请求，不发送任务正文"} onClick={onTest}>测试连接</Button>}
        {provider.credentialSource === "credentials" ? (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onConnect}>
            {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {busy ? "保存中..." : "更新密钥"}
          </Button>
        ) : !provider.connected ? (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onConnect}>
            <Link2 data-icon="inline-start" />
            连接
          </Button>
        ) : null}
        {provider.credentialSource === "credentials" && !provider.custom ? (
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
              disabled={locked}
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
  compact = false,
}: {
  provider?: DesktopProviderInfo
  compact?: boolean
}): React.JSX.Element {
  const BrandIcon = provider ? resolveProviderBrandIcon(provider.name) : undefined

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground ring-1 ring-foreground/10",
        compact
          ? "size-5 rounded-sm bg-transparent ring-0 [&_svg]:size-3.5"
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

function sourceLabel(source: DesktopProviderCredentialSource, label?: string): string {
  if (source === "credentials") return label ?? "API 密钥"
  if (source === "environment") return label ? `环境变量 · ${label}` : "环境变量"
  if (source === "subscription") return label ? `开发工具订阅 · ${label}` : "开发工具订阅"
  if (source === "local") return "本地服务"
  if (source === "configured") return label ?? "已配置"
  return "未连接"
}
