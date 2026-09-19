import { ChevronDown, Search, Settings2 } from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import type { DesktopModel } from "@shared/session-types"
import { PickerMenuItem } from "./controls"

const PROVIDER_PREVIEW_LIMIT = 6

const INPUT_MODALITY_LABELS: Record<string, string> = {
  text: "文本",
  image: "图像",
  audio: "音频",
  video: "视频",
  pdf: "PDF",
}

type ProviderGroup = {
  id: string
  title: string
  models: DesktopModel[]
}

function matchesQuery(model: DesktopModel, query: string): boolean {
  if (!query) return true
  return (
    model.label.toLocaleLowerCase().includes(query) ||
    model.id.toLocaleLowerCase().includes(query) ||
    model.provider.toLocaleLowerCase().includes(query) ||
    model.providerName.toLocaleLowerCase().includes(query)
  )
}

function groupModelsByProvider(models: DesktopModel[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const model of models) {
    const existing = groups.get(model.providerName)
    if (existing) {
      existing.models.push(model)
      continue
    }
    groups.set(model.providerName, {
      id: model.providerName,
      title: model.provider,
      models: [model],
    })
  }
  return [...groups.values()]
}

function isSelectedModel(
  model: DesktopModel,
  selectedModel: string | null,
  selectedProvider: string | null
): boolean {
  return model.id === selectedModel && model.providerName === selectedProvider
}

function previewModelsForGroup(
  group: ProviderGroup,
  selectedModel: string | null,
  selectedProvider: string | null,
  collapsed: boolean
): DesktopModel[] {
  if (!collapsed) return group.models
  const preview = group.models.slice(0, PROVIDER_PREVIEW_LIMIT)
  const selected = group.models.find((model) =>
    isSelectedModel(model, selectedModel, selectedProvider)
  )
  if (
    !selected ||
    preview.some(
      (model) => model.id === selected.id && model.providerName === selected.providerName
    )
  ) {
    return preview
  }
  return [...preview.slice(0, PROVIDER_PREVIEW_LIMIT - 1), selected]
}

function formatContextWindow(value: number | undefined): string {
  if (typeof value !== "number" || value <= 0) return "—"
  if (value >= 1_000_000) {
    return `${formatCompactCount(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `${formatCompactCount(value / 1_000)}K`
  }
  return String(value)
}

function formatCompactCount(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(parseFloat(value.toFixed(2)))
}

export function formatInput(model: DesktopModel): string {
  const inputs = model.inputModalities
  if (inputs && inputs.length > 0) {
    return inputs.map((item) => INPUT_MODALITY_LABELS[item] ?? item).join("、")
  }
  if (model.inputCapabilities?.image === "native") return "文本、图像"
  if (model.inputCapabilities?.image === "unsupported") return "文本（不支持图像）"
  return "文本（图像能力未知）"
}

export function formatReasoning(model: DesktopModel): string {
  if (model.reasoning !== true) return model.reasoning === false ? "不支持推理" : "—"
  const efforts = model.reasoningEfforts
  return efforts && efforts.length > 0 ? `支持推理（${efforts.join(" / ")}）` : "支持推理"
}

function ModelSearchField({
  value,
  placeholder,
  label,
  autoFocus,
  onChange,
}: {
  value: string
  placeholder: string
  label: string
  autoFocus?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="flex h-9 shrink-0 items-center gap-2 px-2 text-ui-muted">
      <Search className="size-3.5 shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-placeholder"
      />
    </label>
  )
}

function ModelHoverDetails({ model }: { model: DesktopModel }): React.JSX.Element {
  const rows = [
    { label: "模型", value: model.label },
    { label: "提供商", value: model.provider },
    { label: "输入", value: formatInput(model) },
    { label: "推理", value: formatReasoning(model) },
    { label: "上下文", value: formatContextWindow(model.contextWindow) },
    { label: "最大输出", value: formatContextWindow(model.outputLimit) },
  ]
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-3 text-xs">
          <span className="shrink-0 text-muted-foreground">{row.label}</span>
          <span className="min-w-0 text-right wrap-break-word">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

function ModelOptionList({
  models,
  selectedModel,
  selectedProvider,
  onSelect,
}: {
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  onSelect: (model: DesktopModel) => void
}): React.JSX.Element {
  return (
    <>
      {models.map((model) => (
        <HoverCard key={`${model.providerName}:${model.id}`}>
          <HoverCardTrigger delay={400} closeDelay={120} render={<div className="w-full" />}>
            <PickerMenuItem
              selected={isSelectedModel(model, selectedModel, selectedProvider)}
              onClick={() => onSelect(model)}
            >
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
            </PickerMenuItem>
          </HoverCardTrigger>
          <HoverCardContent side="right" align="start" sideOffset={10} className="w-56 p-3">
            <ModelHoverDetails model={model} />
          </HoverCardContent>
        </HoverCard>
      ))}
    </>
  )
}

export function ModelPicker({
  open,
  onOpenChange,
  models,
  selectedModel,
  selectedProvider,
  modelLabel,
  onSelectModel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  onSelectModel: (model: DesktopModel) => void
}): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [dialogQuery, setDialogQuery] = useState("")

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleGroups = useMemo(() => {
    const matched = models.filter((model) => matchesQuery(model, normalizedQuery))
    return groupModelsByProvider(matched)
  }, [models, normalizedQuery])

  const expandedModels = useMemo(
    () => models.filter((model) => model.providerName === expandedProvider),
    [models, expandedProvider]
  )
  const expandedProviderName = expandedModels[0]?.provider ?? expandedProvider ?? ""
  const normalizedDialogQuery = dialogQuery.trim().toLocaleLowerCase()
  const visibleExpandedModels = expandedModels.filter((model) =>
    matchesQuery(model, normalizedDialogQuery)
  )

  const selectModel = (model: DesktopModel): void => {
    onSelectModel(model)
    setQuery("")
    setDialogQuery("")
    setExpandedProvider(null)
    onOpenChange(false)
  }

  const openProviderDialog = (providerId: string): void => {
    setDialogQuery("")
    setExpandedProvider(providerId)
    onOpenChange(false)
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) setQuery("")
          onOpenChange(next)
        }}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="h-8 max-w-52 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground"
            />
          }
        >
          <span className="min-w-0 truncate">{modelLabel}</span>
          <ChevronDown data-icon="inline-end" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="w-[320px] gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
        >
          <ModelSearchField
            autoFocus
            value={query}
            label="搜索模型"
            placeholder="搜索模型"
            onChange={setQuery}
          />
          <ScrollArea
            horizontal={false}
            className="max-h-64"
            viewportClassName="max-h-64 flex-none"
            contentClassName="py-0.5"
          >
            {visibleGroups.map((group, index) => {
              const collapsed = !normalizedQuery && group.models.length > PROVIDER_PREVIEW_LIMIT
              const previewModels = previewModelsForGroup(
                group,
                selectedModel,
                selectedProvider,
                collapsed
              )
              return (
                <div key={group.id} className={index === 0 ? undefined : "pt-1"}>
                  <div className="text-ui-caption px-2 pt-1.5 pb-1 text-ui-muted">
                    {group.title}
                  </div>
                  <ModelOptionList
                    models={previewModels}
                    selectedModel={selectedModel}
                    selectedProvider={selectedProvider}
                    onSelect={selectModel}
                  />
                  {collapsed ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 w-full justify-start px-2 text-xs font-normal text-muted-foreground"
                      onClick={() => openProviderDialog(group.id)}
                    >
                      {`展开全部 ${group.models.length} 个模型`}
                    </Button>
                  ) : null}
                </div>
              )
            })}
            {visibleGroups.length === 0 ? (
              <p className="px-2 py-5 text-center text-xs text-ui-muted">
                {models.length === 0 ? "没有可用模型" : "没有匹配的模型"}
              </p>
            ) : null}
          </ScrollArea>
          <div className="mt-1 pt-1">
            <Separator className="mb-1" />
            <PickerMenuItem disabled title="模型管理将在后续版本接入" onClick={() => undefined}>
              <Settings2 />
              <span>模型管理</span>
              <span className="text-ui-caption ml-auto text-muted-foreground">即将支持</span>
            </PickerMenuItem>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={expandedProvider !== null}
        onOpenChange={(next) => {
          if (!next) {
            setExpandedProvider(null)
            setDialogQuery("")
          }
        }}
      >
        <DialogContent className="flex flex-col gap-0 p-1.5 sm:max-w-md">
          <DialogHeader className="px-2 pt-1.5 pr-10 pb-1">
            <DialogTitle className="text-sm">{`${expandedProviderName} 的模型`}</DialogTitle>
            <DialogDescription className="sr-only">搜索并选择该供应商的模型</DialogDescription>
          </DialogHeader>
          <ModelSearchField
            autoFocus
            value={dialogQuery}
            label={`搜索 ${expandedProviderName} 模型`}
            placeholder={`搜索 ${expandedProviderName} 模型`}
            onChange={setDialogQuery}
          />
          <ScrollArea
            horizontal={false}
            className="max-h-80"
            viewportClassName="max-h-80 flex-none"
            contentClassName="py-0.5"
          >
            <ModelOptionList
              models={visibleExpandedModels}
              selectedModel={selectedModel}
              selectedProvider={selectedProvider}
              onSelect={selectModel}
            />
            {visibleExpandedModels.length === 0 ? (
              <p className="px-2 py-5 text-center text-xs text-ui-muted">没有匹配的模型</p>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
