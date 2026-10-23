import { toast } from "@renderer/lib/toast"
import { createElement, useEffect, useRef, useState } from "react"
import { AudioLines, Brain, CircleHelp, FileText, Image, Sparkles, Type, Video } from "lucide-react"
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
import { Card, CardContent } from "@renderer/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsibleTrigger,
} from "@renderer/components/motion/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { Button } from "@renderer/components/ui/button"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { ProviderDefaultsSnapshot } from "@shared/provider-defaults-types"
import { resolveProviderBrandIcon } from "./provider-brand-icons"
import { effortLabel } from "../../conversation-page/composer/effort-picker"
import { errorMessage } from "../shared/settings-error-message"

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
const inputTypes = [
  { id: "text", label: "文本", icon: Type },
  { id: "image", label: "图片", icon: Image },
  { id: "video", label: "视频", icon: Video },
  { id: "audio", label: "音频", icon: AudioLines },
  { id: "pdf", label: "PDF", icon: FileText },
] as const
type Draft = { provider: string; model: string; effort: string | null }
// A reopened settings page must read after a save started by the previous instance.
let pendingDefaultsSave: Promise<void> | null = null

function draftFromSnapshot(next: ProviderDefaultsSnapshot): Draft {
  const model = next.models.find(
    (item) => item.providerName === next.provider && item.id === next.model
  )
  return {
    provider: next.provider ?? "",
    model: next.model ?? "",
    effort: next.effort && model?.reasoningEfforts?.includes(next.effort) ? next.effort : null,
  }
}

export function ProviderDefaultsControl({ onChanged }: { onChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<ProviderDefaultsSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const saving = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<(() => Promise<void>) | null>(null)

  function accept(next: ProviderDefaultsSnapshot) {
    setSnapshot(next)
    setDraft(draftFromSnapshot(next))
    useDesktopSessionStore.setState({
      models: next.models,
      defaultModel: next.model ?? undefined,
      defaultProvider: next.provider ?? undefined,
    })
  }
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    const read = async () => {
      await pendingDefaultsSave
      return window.desktop.providerDefaults.snapshot()
    }
    void read()
      .then((next) => {
        if (!cancelled) accept(next)
      })
      .catch((failure) => {
        if (!cancelled) setError(errorMessage(failure))
      })
    return () => {
      cancelled = true
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
      // Leaving settings must not drop a choice made during the debounce window.
      const flush = pendingSave.current
      pendingSave.current = null
      if (flush) void flush()
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
  const inputModalities = new Set(selected ? (selected.inputModalities ?? ["text"]) : [])
  if (selected?.inputCapabilities?.image === "native") inputModalities.add("image")
  if (selected?.inputCapabilities?.image === "unsupported") inputModalities.delete("image")

  function queueSave(next: Draft) {
    if (!snapshot || saving.current) return
    setDraft(next)
    setError(null)
    if (timer.current !== null) clearTimeout(timer.current)
    pendingSave.current = null
    const saved = draftFromSnapshot(snapshot)
    if (
      !snapshot.disabled &&
      next.provider === saved.provider &&
      next.model === saved.model &&
      next.effort === saved.effort
    )
      return
    pendingSave.current = async () => {
      const request = save(next)
      pendingDefaultsSave = request
      try {
        await request
      } finally {
        if (pendingDefaultsSave === request) pendingDefaultsSave = null
      }
    }
    timer.current = setTimeout(() => {
      timer.current = null
      const flush = pendingSave.current
      pendingSave.current = null
      if (flush) void flush()
    }, 400)
  }
  function chooseProvider(provider: string) {
    if (!snapshot || saving.current) return
    const model = snapshot.models.find((item) => item.providerName === provider)
    queueSave({
      provider,
      model: model?.id ?? "",
      effort:
        draft?.effort && model?.reasoningEfforts?.includes(draft.effort) ? draft.effort : null,
    })
  }
  function chooseModel(id: string) {
    if (!draft || saving.current) return
    const model = providerModels.find((item) => item.id === id)
    if (!model) return
    queueSave({
      ...draft,
      model: id,
      effort: draft.effort && model.reasoningEfforts?.includes(draft.effort) ? draft.effort : null,
    })
  }
  async function reload() {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      const next = await window.desktop.providerDefaults.snapshot()
      if (mounted.current) {
        accept(next)
        setError(null)
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function save(nextDraft: Draft) {
    if (
      !snapshot ||
      saving.current ||
      !snapshot.models.some(
        (item) => item.providerName === nextDraft.provider && item.id === nextDraft.model
      )
    )
      return
    saving.current = true
    if (mounted.current) setBusy(true)
    let modelSaved = false
    try {
      let next: ProviderDefaultsSnapshot
      if (
        nextDraft.provider === snapshot.provider &&
        nextDraft.model === snapshot.model &&
        !snapshot.disabled
      ) {
        next = await window.desktop.providerDefaults.updateEffort({
          effort: nextDraft.effort,
          expectedRevision: snapshot.revision,
        })
      } else {
        const bootstrap = await window.desktop.sessions.setDefaultModel({
          provider: nextDraft.provider,
          model: nextDraft.model,
          effort: nextDraft.effort ?? "",
        })
        modelSaved = true
        useDesktopSessionStore.setState({
          models: bootstrap.models,
          defaultModel: bootstrap.defaultModel,
          defaultProvider: bootstrap.defaultProvider,
        })
        next = await window.desktop.providerDefaults.snapshot()
      }
      if (mounted.current) accept(next)
      if (mounted.current) {
        try {
          await onChanged()
        } catch (failure) {
          const message = `设置已保存，但列表刷新失败：${errorMessage(failure)}`
          if (mounted.current) setError(message)
          else toast.error(message)
        }
      }
    } catch (failure) {
      let recovered: ProviderDefaultsSnapshot | null = null
      if (!modelSaved && mounted.current) {
        // Either write API may reject after persisting, while preparing its response.
        try {
          recovered = await window.desktop.providerDefaults.snapshot()
        } catch {
          // Keep the choice hidden until its actual saved value can be read.
        }
      }
      const message = modelSaved
        ? `默认模型已保存，但重新读取失败：${errorMessage(failure)}`
        : errorMessage(failure)
      if (mounted.current) {
        if (recovered) {
          accept(recovered)
        } else setSnapshot(null)
        if (recovered && message.startsWith("当前有任务正在运行")) toast.error(message)
        else setError(message)
      } else toast.error(message)
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="flex w-full flex-col gap-4" aria-labelledby="provider-defaults-heading">
      <div className="flex items-center gap-1">
        <h2 id="provider-defaults-heading" className="text-base font-semibold">
          默认模型
        </h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                shape="circle"
                aria-label="默认模型说明"
                className="text-muted-foreground"
              />
            }
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>用于新对话，不改变已有对话。</TooltipContent>
        </Tooltip>
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reload()}>
            重新读取
          </Button>
        </div>
      ) : null}

      {!snapshot || !draft ? (
        error ? null : (
          <Skeleton className="h-28 w-full" />
        )
      ) : (
        <Card
          className="@container/model-defaults gap-0 rounded-2xl py-0"
          aria-label="新对话的默认模型"
        >
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
            <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center" aria-hidden="true">
                {BrandIcon ? (
                  createElement(BrandIcon, { size: 28 })
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
                  {selected ? (
                    <span
                      className="inline-flex items-center gap-2 border-l border-border pl-2"
                      aria-label="模型输入能力"
                    >
                      {inputTypes
                        .filter((type) => inputModalities.has(type.id))
                        .map(({ id, label, icon: Icon }) => (
                          <Tooltip key={id}>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  tabIndex={0}
                                  aria-label={`支持${label}输入`}
                                  className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                              }
                            >
                              <Icon className="size-3.5" aria-hidden="true" />
                            </TooltipTrigger>
                            <TooltipContent>{`支持${label}输入`}</TooltipContent>
                          </Tooltip>
                        ))}
                    </span>
                  ) : null}
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
            </div>
          </CardContent>
          <div className="px-5 pb-4">
            {efforts.length ? (
              <div className="flex min-w-0 flex-col gap-2.5 @min-[32rem]/model-defaults:flex-row @min-[32rem]/model-defaults:items-center @min-[32rem]/model-defaults:gap-5">
                <span
                  id="provider-thinking-heading"
                  className="flex shrink-0 items-center gap-2 text-xs font-medium"
                >
                  <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
                  思考方式
                </span>
                <div className="max-w-full min-w-0 scrollbar-thin overflow-x-auto overscroll-x-contain">
                  <ToggleGroup
                    aria-labelledby="provider-thinking-heading"
                    variant="default"
                    size="sm"
                    value={[draft.effort ?? "_default"]}
                    disabled={busy}
                    onValueChange={(values) => {
                      const value = values[0]
                      if (typeof value === "string") {
                        queueSave({ ...draft, effort: value === "_default" ? null : value })
                      }
                    }}
                    className="w-max gap-1 rounded-xl bg-muted/60 p-1"
                  >
                    <ToggleGroupItem
                      value="_default"
                      className="h-8 rounded-lg px-3 text-muted-foreground transition-colors aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-border"
                    >
                      交给模型
                    </ToggleGroupItem>
                    {efforts.map((effort) => (
                      <ToggleGroupItem
                        key={effort}
                        value={effort}
                        className="h-8 rounded-lg px-3 text-muted-foreground transition-colors aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-border"
                      >
                        {thinkingLabels[effort] ?? effortLabel(effort)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">该模型没有提供可调整的思考选项。</p>
            )}
          </div>
          <Collapsible className="border-t border-border/60">
            <CollapsibleTrigger className="min-h-10 gap-2 rounded-none px-5 py-2.5 text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:ring-inset">
              模型详情
              <CollapsibleIndicator className="ml-auto" />
            </CollapsibleTrigger>
            <CollapsibleContent contentClassName="px-5 pb-4 pt-1">
              <dl className="grid min-w-0 gap-x-6 gap-y-4 text-xs @min-[28rem]/model-defaults:grid-cols-3">
                {selected ? (
                  <>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <dt className="text-muted-foreground">上下文容量</dt>
                      <dd className="leading-relaxed tabular-nums">
                        {selected.contextWindow
                          ? `${selected.contextWindow.toLocaleString()} Token`
                          : "服务未提供"}
                      </dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <dt className="text-muted-foreground">图片输入</dt>
                      <dd className="leading-relaxed">
                        {selected.inputCapabilities?.image === "native"
                          ? "支持"
                          : selected.inputCapabilities?.image === "unsupported"
                            ? "不支持"
                            : "尚未确认"}
                      </dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <dt className="text-muted-foreground">思考选项</dt>
                      <dd className="leading-relaxed">
                        {efforts.length ? "可调整" : "服务未提供可调选项"}
                      </dd>
                    </div>
                  </>
                ) : null}
                <div className="flex min-w-0 flex-col gap-1.5 @min-[28rem]/model-defaults:col-span-3">
                  <dt className="text-muted-foreground">加速模式</dt>
                  <dd className="leading-relaxed [overflow-wrap:anywhere]">
                    {snapshot.fastModeReason}
                  </dd>
                </div>
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}
      {snapshot && !snapshot.models.length ? (
        <p className="text-xs text-muted-foreground">先在下方连接供应商，可用模型会出现在这里。</p>
      ) : null}
    </section>
  )
}
