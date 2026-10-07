import { toast } from "@renderer/lib/toast"
import { useEffect, useState } from "react"
import { Brain, Image, Sparkles } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { Field, FieldLabel } from "@renderer/components/ui/field"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"
import { resolveProviderBrandIcon } from "./provider-brand-icons"
import { effortLabel } from "../conversation-page/composer/effort-picker"
import { errorMessage } from "./settings-error-message"

const thinkingLabels: Record<string, string> = {
  none: "直接回答",
  minimal: "简短思考",
  low: "轻量思考",
  medium: "适度思考",
  high: "深入思考",
  xhigh: "仔细推敲",
  max: "充分推敲",
  default: "模型默认",
}
type Draft = { provider: string; model: string; effort: string | null }

export function ProviderDefaultsControl({ onChanged }: { onChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<ProviderDefaultsSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  function accept(next: ProviderDefaultsSnapshot) {
    const model = next.models.find(
      (item) => item.providerName === next.provider && item.id === next.model
    )
    setSnapshot(next)
    setDraft({
      provider: next.provider ?? "",
      model: next.model ?? "",
      effort: next.effort && model?.reasoningEfforts?.includes(next.effort) ? next.effort : null,
    })
  }
  useEffect(() => {
    let cancelled = false
    void window.desktop.providerDefaults
      .snapshot()
      .then((next) => {
        if (!cancelled) accept(next)
      })
      .catch((failure) => {
        if (!cancelled) setError(errorMessage(failure))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const selected = snapshot?.models.find(
    (item) => item.providerName === draft?.provider && item.id === draft?.model
  )
  const providerModels =
    snapshot?.models.filter((item) => item.providerName === draft?.provider) ?? []
  const providers = [
    ...new Map(
      (snapshot?.models ?? []).map((model) => [model.providerName, model.provider])
    ).entries(),
  ]
  const BrandIcon = draft?.provider ? resolveProviderBrandIcon(draft.provider) : undefined
  const providerLabel = providers.find(([name]) => name === draft?.provider)?.[1] ?? draft?.provider
  const efforts = [...new Set(selected?.reasoningEfforts ?? [])]
  const savedModel = snapshot?.models.find(
    (item) => item.providerName === snapshot.provider && item.id === snapshot.model
  )
  const savedEffort =
    snapshot?.effort && savedModel?.reasoningEfforts?.includes(snapshot.effort)
      ? snapshot.effort
      : null
  const sameModel = draft?.provider === snapshot?.provider && draft?.model === snapshot?.model
  const dirty = Boolean(snapshot?.disabled || !sameModel || draft?.effort !== savedEffort)
  function chooseProvider(provider: string) {
    if (!snapshot || busy) return
    const model = snapshot.models.find((item) => item.providerName === provider)
    setDraft({
      provider,
      model: model?.id ?? "",
      effort:
        draft?.effort && model?.reasoningEfforts?.includes(draft.effort) ? draft.effort : null,
    })
    setError(null)
  }
  function chooseModel(id: string) {
    if (!draft || busy) return
    const model = providerModels.find((item) => item.id === id)
    if (!model) return
    setDraft({
      ...draft,
      model: id,
      effort: draft.effort && model.reasoningEfforts?.includes(draft.effort) ? draft.effort : null,
    })
    setError(null)
  }
  async function save() {
    if (!snapshot || !draft || !selected || !dirty || busy) return
    setBusy(true)
    setError(null)
    try {
      if (sameModel && !snapshot.disabled) {
        accept(
          await window.desktop.providerDefaults.updateEffort({
            effort: draft.effort,
            expectedRevision: snapshot.revision,
          })
        )
      } else {
        const bootstrap = await window.desktop.sessions.setDefaultModel({
          provider: draft.provider,
          model: draft.model,
          effort: draft.effort ?? "",
        })
        useDesktopSessionStore.setState({
          models: bootstrap.models,
          defaultModel: bootstrap.defaultModel,
          defaultProvider: bootstrap.defaultProvider,
        })
        accept(await window.desktop.providerDefaults.snapshot())
      }
      await onChanged()
      toast.success("默认设置已更新，新对话就用它。")
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex w-full flex-col gap-4" aria-labelledby="provider-defaults-heading">
      <h2 id="provider-defaults-heading" className="text-base font-semibold">
        默认模型
      </h2>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!snapshot || !draft ? (
        error ? (
          <Button
            variant="ghost"
            className="self-start"
            onClick={() =>
              void window.desktop.providerDefaults
                .snapshot()
                .then((next) => {
                  accept(next)
                  setError(null)
                })
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            重新读取
          </Button>
        ) : (
          <Skeleton className="h-28 w-full" />
        )
      ) : (
        <Card className="gap-0 py-0">
          <CardHeader className="sr-only">
            <CardTitle>新对话的默认模型</CardTitle>
            <CardDescription>选择供应商、模型和思考方式后保存，不改变已有对话。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
              <span
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted"
                aria-hidden="true"
              >
                {BrandIcon ? (
                  <BrandIcon size={24} />
                ) : (
                  <Sparkles className="size-5 text-muted-foreground" />
                )}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-base leading-snug font-semibold break-words">
                  {selected?.label ?? (draft.model || "选择默认模型")}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{providerLabel || "先连接供应商"}</span>
                  {selected?.inputCapabilities?.image === "native" ? (
                    <Badge variant="secondary">
                      <Image data-icon="inline-start" />
                      可读图片
                    </Badge>
                  ) : null}
                  {selected && !dirty ? <Badge variant="outline">当前默认</Badge> : null}
                  {dirty && selected ? <Badge variant="outline">待保存</Badge> : null}
                </div>
              </div>
            </div>
            <div
              role="group"
              aria-label="默认模型操作"
              className="flex max-w-full shrink-0 flex-wrap items-center gap-2"
            >
              <Field className="w-auto">
                <FieldLabel htmlFor="provider-default-provider" className="sr-only">
                  默认供应商
                </FieldLabel>
                <Select
                  value={draft.provider}
                  onValueChange={(value) => {
                    if (typeof value === "string") chooseProvider(value)
                  }}
                >
                  <SelectTrigger
                    id="provider-default-provider"
                    aria-label="默认供应商"
                    disabled={busy || !providers.length}
                    className="w-auto rounded-full data-[size=default]:h-8"
                  >
                    <SelectValue>供应商</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      {providers.map(([name, label]) => (
                        <SelectItem key={name} value={name}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="provider-default-model" className="sr-only">
                  默认模型
                </FieldLabel>
                <Select
                  value={draft.model}
                  onValueChange={(value) => {
                    if (typeof value === "string") chooseModel(value)
                  }}
                >
                  <SelectTrigger
                    id="provider-default-model"
                    aria-label="默认模型"
                    disabled={busy || !providerModels.length}
                    className="w-auto rounded-full data-[size=default]:h-8"
                  >
                    <SelectValue>更换模型</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      {providerModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {dirty ? (
                <Button
                  size="sm"
                  disabled={busy || !selected}
                  aria-label="保存默认设置"
                  onClick={() => void save()}
                >
                  {busy ? "保存中…" : "保存"}
                </Button>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3 py-3">
            {efforts.length ? (
              <Field
                orientation="horizontal"
                className="w-auto min-w-0 flex-1 flex-wrap items-center gap-3"
              >
                <FieldLabel id="provider-thinking-heading">
                  <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
                  思考方式
                </FieldLabel>
                <ToggleGroup
                  aria-labelledby="provider-thinking-heading"
                  variant="outline"
                  size="sm"
                  value={[draft.effort ?? "_default"]}
                  disabled={busy}
                  onValueChange={(values) => {
                    const value = values[0]
                    if (typeof value === "string") {
                      setDraft({ ...draft, effort: value === "_default" ? null : value })
                      setError(null)
                    }
                  }}
                  className="flex max-w-full flex-wrap justify-start"
                >
                  <ToggleGroupItem value="_default">交给模型</ToggleGroupItem>
                  {efforts.map((effort) => (
                    <ToggleGroupItem key={effort} value={effort}>
                      {thinkingLabels[effort] ?? effortLabel(effort)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            ) : (
              <span className="text-xs text-muted-foreground">用于新对话</span>
            )}
            <details className="max-w-full text-xs text-muted-foreground">
              <summary className="cursor-pointer">模型详情</summary>
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
                {selected ? (
                  <>
                    <dt>上下文容量</dt>
                    <dd>
                      {selected.contextWindow
                        ? `${selected.contextWindow.toLocaleString()} Token`
                        : "服务未提供"}
                    </dd>
                    <dt>图片输入</dt>
                    <dd>
                      {selected.inputCapabilities?.image === "native"
                        ? "支持"
                        : selected.inputCapabilities?.image === "unsupported"
                          ? "不支持"
                          : "尚未确认"}
                    </dd>
                    <dt>思考选项</dt>
                    <dd>{efforts.length ? "可调整" : "服务未提供可调选项"}</dd>
                  </>
                ) : null}
                <dt>加速模式</dt>
                <dd className="break-words">{snapshot.fastModeReason}</dd>
              </dl>
            </details>
          </CardFooter>
        </Card>
      )}
      {snapshot && !snapshot.models.length ? (
        <p className="text-xs text-muted-foreground">先在下方连接供应商，可用模型会出现在这里。</p>
      ) : null}
    </section>
  )
}
