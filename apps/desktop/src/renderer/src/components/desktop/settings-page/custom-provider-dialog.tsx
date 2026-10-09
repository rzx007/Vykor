import { LoaderCircle, Plus, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Separator } from "@renderer/components/ui/separator"
import type {
  DesktopCustomProviderInput,
  DesktopInputSupport,
  DesktopProviderInfo,
} from "@shared/provider-types"
import {
  type CustomProviderFormState,
  type CustomProviderModelRow,
  validateCustomProviderForm,
} from "./custom-provider-form"
import { FieldHelp } from "./field-help"
import { RequestHeaderEditor } from "./request-header-editor"
import { rowsFromHeaders } from "./request-header-form"

const SAVED_CREDENTIAL_MASK = "••••••••••••"

/** 限制档位里的哨兵值：不填具体数值，交给模型目录匹配。 */
const LIMIT_AUTO = "auto"

/** 上下文窗口档位（token 数）。 */
const CONTEXT_WINDOW_TIERS = ["32000", "64000", "128000", "200000", "256000", "1000000"]

/** 最大输出档位（token 数）。 */
const MAX_OUTPUT_TIERS = ["4096", "8192", "16384", "32000", "64000", "128000"]

const IMAGE_SUPPORT_OPTIONS: { value: DesktopInputSupport; label: string }[] = [
  { value: "unknown", label: "图片能力未知" },
  { value: "native", label: "支持图片" },
  { value: "unsupported", label: "不支持图片" },
]

interface LimitOption {
  value: string
  label: string
}

/** 把 token 数写成 32k / 1M 这样的档位文案。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** 档位选项；已有配置不在档位里时补一项，避免编辑旧值时把配置改掉。 */
function limitOptions(tiers: string[], current: string): LimitOption[] {
  const trimmed = current.trim()
  const options: LimitOption[] = tiers.map((tier) => ({
    value: tier,
    label: formatTokens(Number(tier)),
  }))
  if (trimmed && !options.some((option) => option.value === trimmed)) {
    const parsed = Number(trimmed)
    options.push({
      value: trimmed,
      label: Number.isSafeInteger(parsed) && parsed > 0 ? formatTokens(parsed) : trimmed,
    })
  }
  return options
}

/** API 密钥输入框的提示文案，随「是否已保存密钥」「是否在编辑已有供应商」变化。 */
function apiKeyPlaceholder(options: {
  showSavedApiKey: boolean
  hasSavedApiKey: boolean
  editing: boolean
}): string {
  if (options.showSavedApiKey) return "已保存在本机"
  if (options.hasSavedApiKey) return "输入新的 API 密钥；留空则继续用已保存的密钥"
  if (options.editing) return "输入 API 密钥；本地服务可留空"
  return "本地服务（如 Ollama）可留空"
}

interface CustomProviderDialogProps {
  open: boolean
  provider?: DesktopProviderInfo
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value: DesktopCustomProviderInput) => void
}

export function CustomProviderDialog({
  open,
  provider,
  busy,
  onOpenChange,
  onSubmit,
}: CustomProviderDialogProps): React.JSX.Element {
  const nextRowId = useRef(1)
  const [form, setForm] = useState<CustomProviderFormState>(() => initialForm(provider))
  const [replacingApiKey, setReplacingApiKey] = useState(false)
  const [invalid, setInvalid] = useState<{ field: string; message: string } | null>(null)
  const hasSavedApiKey = provider?.credentialSource === "credentials"
  const showSavedApiKey = hasSavedApiKey && !replacingApiKey

  /* eslint-disable react-hooks/set-state-in-effect -- Opening the dialog resets its editable draft. */
  useEffect(() => {
    if (!open) return
    setForm(initialForm(provider))
    setReplacingApiKey(false)
    setInvalid(null)
  }, [open, provider])
  /* eslint-enable react-hooks/set-state-in-effect */

  const rowKey = (prefix: string): string => `${prefix}-${nextRowId.current++}`
  const updateModel = (key: string, patch: Partial<Omit<CustomProviderModelRow, "key">>): void => {
    setForm((current) => ({
      ...current,
      models: current.models.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }))
  }
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const result = validateCustomProviderForm(form)
    if (!result.ok) {
      setInvalid({ field: result.field, message: result.message })
      return
    }
    setInvalid(null)
    onSubmit(result.value)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>
              {provider ? `编辑 ${provider.displayName}` : "添加自定义供应商"}
            </DialogTitle>
            <DialogDescription>
              配置 OpenAI 兼容接口。API 密钥和机密请求头单独保存到宿主凭据；提交新密钥时会请求模型列表验证，可能按上游规则收费。
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={invalid?.field === "id" || undefined}>
              <FieldLabel htmlFor="custom-provider-id">供应商 ID</FieldLabel>
              <Input
                id="custom-provider-id"
                value={form.id}
                disabled={Boolean(provider)}
                aria-invalid={invalid?.field === "id" || undefined}
                onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))}
                placeholder="小写字母、数字、- 或 _；创建后不可修改"
              />
              {invalid?.field === "id" ? (
                <FieldDescription>{invalid.message}</FieldDescription>
              ) : null}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={invalid?.field === "displayName" || undefined}>
                <FieldLabel htmlFor="custom-provider-name">显示名称</FieldLabel>
                <Input
                  id="custom-provider-name"
                  value={form.displayName}
                  aria-invalid={invalid?.field === "displayName" || undefined}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder="我的 AI 供应商"
                />
              </Field>
              <Field data-invalid={invalid?.field === "baseUrl" || undefined}>
                <FieldLabel htmlFor="custom-provider-url">基础 URL</FieldLabel>
                <Input
                  id="custom-provider-url"
                  value={form.baseUrl}
                  aria-invalid={invalid?.field === "baseUrl" || undefined}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="https://api.example.com/v1"
                />
                {invalid?.field === "baseUrl" ? (
                  <FieldDescription>{invalid.message}</FieldDescription>
                ) : null}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="custom-provider-key">
                {provider ? "API 密钥" : "API 密钥（可选）"}
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="custom-provider-key"
                  className="flex-1"
                  type={showSavedApiKey ? "text" : "password"}
                  autoComplete="off"
                  readOnly={showSavedApiKey}
                  value={showSavedApiKey ? SAVED_CREDENTIAL_MASK : form.apiKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, apiKey: event.target.value }))
                  }
                  placeholder={apiKeyPlaceholder({
                    showSavedApiKey,
                    hasSavedApiKey,
                    editing: Boolean(provider),
                  })}
                />
                {showSavedApiKey ? (
                  <Button type="button" variant="outline" onClick={() => setReplacingApiKey(true)}>
                    更换
                  </Button>
                ) : null}
              </div>
              {showSavedApiKey ? (
                <FieldDescription>
                  密钥已保存在本机，出于安全考虑不显示原文；不更换就继续使用。
                </FieldDescription>
              ) : null}
            </Field>

            <Separator />

            <FieldSet data-invalid={invalid?.field === "models" || undefined}>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <FieldLegend className="mb-0">模型</FieldLegend>
                  <FieldHelp label="模型配置说明">
                    至少添加一个可用模型。上下文窗口和最大输出保持「自动匹配」时，按模型 ID 去模型目录匹配，匹配不到才用默认值；手动选的档位优先。
                  </FieldHelp>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      models: [
                        ...current.models,
                        {
                          key: rowKey("model"),
                          id: "",
                          displayName: "",
                          imageInputSupport: "unknown",
                          contextWindow: "",
                          maxOutputTokens: "",
                        },
                      ],
                    }))
                  }
                >
                  <Plus data-icon="inline-start" />
                  添加模型
                </Button>
              </div>
              {invalid?.field === "models" ? (
                <FieldDescription>{invalid.message}</FieldDescription>
              ) : null}
              <div className="flex flex-col gap-3">
                {form.models.map((model, index) => {
                  const contextOptions: LimitOption[] = [
                    { value: LIMIT_AUTO, label: "自动匹配" },
                    ...limitOptions(CONTEXT_WINDOW_TIERS, model.contextWindow),
                  ]
                  const outputOptions: LimitOption[] = [
                    { value: LIMIT_AUTO, label: "自动匹配" },
                    ...limitOptions(MAX_OUTPUT_TIERS, model.maxOutputTokens),
                  ]
                  return (
                    <div key={model.key} className="grid grid-cols-[1fr_1fr_10rem_auto] gap-2">
                      <Input
                        value={model.id}
                        aria-label={`模型 ${index + 1} ID`}
                        aria-invalid={invalid?.field === "models" || undefined}
                        onChange={(event) => updateModel(model.key, { id: event.target.value })}
                        placeholder="model-id"
                      />
                      <Input
                        value={model.displayName}
                        aria-label={`模型 ${index + 1} 显示名称`}
                        onChange={(event) =>
                          updateModel(model.key, { displayName: event.target.value })
                        }
                        placeholder="显示名称（可选）"
                      />
                      <Select
                        items={IMAGE_SUPPORT_OPTIONS}
                        value={model.imageInputSupport}
                        onValueChange={(value) => {
                          if (typeof value !== "string") return
                          updateModel(model.key, {
                            imageInputSupport: value as DesktopInputSupport,
                          })
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`模型 ${index + 1} 图片输入能力`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {IMAGE_SUPPORT_OPTIONS.map(({ value, label }) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除模型 ${index + 1}`}
                        disabled={form.models.length === 1}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            models: current.models.filter((item) => item.key !== model.key),
                          }))
                        }
                      >
                        <Trash2 data-icon="inline-start" />
                      </Button>
                      <Field className="gap-1.5">
                        <FieldLabel htmlFor={`model-${index}-context-window`}>上下文窗口</FieldLabel>
                        <Select
                          items={contextOptions}
                          value={model.contextWindow.trim() ? model.contextWindow : LIMIT_AUTO}
                          onValueChange={(value) => {
                            if (typeof value !== "string") return
                            updateModel(model.key, {
                              contextWindow: value === LIMIT_AUTO ? "" : value,
                            })
                          }}
                        >
                          <SelectTrigger
                            id={`model-${index}-context-window`}
                            className="w-full"
                            aria-invalid={invalid?.field === "models" || undefined}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent
                            align="start"
                            alignItemWithTrigger={false}
                            className="max-h-[min(18rem,var(--available-height))]"
                          >
                            <SelectGroup>
                              {contextOptions.map(({ value, label }) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field className="gap-1.5">
                        <FieldLabel htmlFor={`model-${index}-max-output`}>最大输出</FieldLabel>
                        <Select
                          items={outputOptions}
                          value={model.maxOutputTokens.trim() ? model.maxOutputTokens : LIMIT_AUTO}
                          onValueChange={(value) => {
                            if (typeof value !== "string") return
                            updateModel(model.key, {
                              maxOutputTokens: value === LIMIT_AUTO ? "" : value,
                            })
                          }}
                        >
                          <SelectTrigger
                            id={`model-${index}-max-output`}
                            className="w-full"
                            aria-invalid={invalid?.field === "models" || undefined}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent
                            align="start"
                            alignItemWithTrigger={false}
                            className="max-h-[min(18rem,var(--available-height))]"
                          >
                            <SelectGroup>
                              {outputOptions.map(({ value, label }) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  )
                })}
              </div>
            </FieldSet>

            <Separator />

            <RequestHeaderEditor
              rows={form.headers}
              invalidMessage={invalid?.field === "headers" ? invalid.message : null}
              onChange={(headers) => {
                setInvalid((current) => (current?.field === "headers" ? null : current))
                setForm((current) => ({ ...current, headers }))
              }}
              onAddRow={() =>
                setForm((current) => ({
                  ...current,
                  headers: [...current.headers, { key: rowKey("header"), name: "", value: "" }],
                }))
              }
            />

          </FieldGroup>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">取消</Button>} />
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {busy ? "保存中..." : provider ? "保存修改" : "添加供应商"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function initialForm(provider?: DesktopProviderInfo): CustomProviderFormState {
  return {
    id: provider?.name ?? "",
    displayName: provider?.displayName ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    models: provider?.models.length
      ? provider.models.map((model, index) => ({
          key: `model-${index}`,
          id: model.id,
          displayName: model.label,
          imageInputSupport: model.imageInputSupport ?? "unknown",
          contextWindow: model.declaredLimits?.contextWindow
            ? String(model.declaredLimits.contextWindow)
            : "",
          maxOutputTokens: model.declaredLimits?.maxOutputTokens
            ? String(model.declaredLimits.maxOutputTokens)
            : "",
        }))
      : [
          {
            key: "model-0",
            id: "",
            displayName: "",
            imageInputSupport: "unknown",
            contextWindow: "",
            maxOutputTokens: "",
          },
        ],
    headers: rowsFromHeaders(provider?.headers, provider?.secretHeaderNames),
    secretHeaderNames: provider?.secretHeaderNames,
  }
}
