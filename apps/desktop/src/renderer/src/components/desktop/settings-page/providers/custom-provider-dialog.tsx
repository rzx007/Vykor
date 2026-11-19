import { Plus, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsibleTrigger,
} from "@renderer/components/motion/collapsible"
import { Input } from "@renderer/components/motion/input"
import { Button } from "@renderer/components/ui/button"
import { Dialog } from "@renderer/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type {
  DesktopCustomProviderInput,
  DesktopInputSupport,
  DesktopProviderInfo,
} from "@shared/provider-types"
import { FieldHelp } from "../shared/field-help"
import {
  type CustomProviderFormState,
  type CustomProviderFormValidation,
  type CustomProviderModelRow,
  validateCustomProviderForm,
} from "./custom-provider-form"
import { ProviderApiKeyField, ProviderDialogForm } from "./provider-dialog-form"
import { RequestHeaderEditor } from "./request-header-editor"
import { rowsFromHeaders } from "./request-header-form"

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
  const fields = useRef<HTMLDivElement>(null)
  const [form, setForm] = useState(() => initialForm(provider))
  const [openParams, setOpenParams] = useState<string[]>([])
  const [replacingApiKey, setReplacingApiKey] = useState(false)
  const [invalid, setInvalid] = useState<Extract<
    CustomProviderFormValidation,
    { ok: false }
  > | null>(null)
  const hasSavedApiKey = provider?.credentialSource === "credentials"

  /* eslint-disable react-hooks/set-state-in-effect -- Opening the dialog resets its editable draft. */
  useEffect(() => {
    if (!open) return
    const draft = initialForm(provider)
    setForm(draft)
    setOpenParams(
      draft.models
        .filter(
          (model) =>
            model.imageInputSupport !== "unknown" || model.contextWindow || model.maxOutputTokens
        )
        .map((model) => model.key)
    )
    setReplacingApiKey(false)
    setInvalid(null)
  }, [open, provider])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (invalid) fields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [invalid])

  const updateField = (field: "id" | "displayName" | "baseUrl" | "apiKey", value: string): void => {
    setForm((current) => ({ ...current, [field]: value }))
    setInvalid((current) => (current?.field === field ? null : current))
  }

  const updateModel = (key: string, patch: Partial<Omit<CustomProviderModelRow, "key">>): void => {
    setForm((current) => ({
      ...current,
      models: current.models.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }))
    setInvalid((current) => (current?.rowKey === key ? null : current))
  }

  const addModel = (): void => {
    const key = `new-model-${nextRowId.current++}`
    setForm((current) => ({ ...current, models: [...current.models, emptyModel(key)] }))
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const result = validateCustomProviderForm(form)
    if (!result.ok) {
      if (result.rowKey && result.modelField && result.modelField !== "id") {
        const key = result.rowKey
        setOpenParams((current) => (current.includes(key) ? current : [...current, key]))
      }
      setInvalid(result)
      return
    }
    setInvalid(null)
    onSubmit(result.value)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <ProviderDialogForm
        wide
        title={provider ? `编辑 ${provider.displayName}` : "添加自定义供应商"}
        busy={busy}
        submitLabel={provider ? "保存修改" : "添加供应商"}
        hasNewKey={Boolean(form.apiKey.trim())}
        onSubmit={submit}
      >
        <FieldGroup ref={fields} className="gap-4">
          <div className="grid gap-4 @sm/provider-form:grid-cols-2">
            <Field className="min-w-0 gap-1.5">
              <FieldLabel htmlFor="custom-provider-name" className="min-h-7 items-center">
                显示名称
              </FieldLabel>
              <Input
                id="custom-provider-name"
                value={form.displayName}
                onChange={(value) => updateField("displayName", value)}
                placeholder="我的 AI 供应商"
                error={invalid?.field === "displayName" ? invalid.message : undefined}
              />
            </Field>
            <Field className="min-w-0 gap-1.5">
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor="custom-provider-id">供应商 ID</FieldLabel>
                <FieldHelp label="供应商 ID 格式">
                  用小写字母或数字开头。可使用小写字母、数字、连字符和下划线。创建后不可修改。
                </FieldHelp>
              </div>
              <Input
                id="custom-provider-id"
                value={form.id}
                disabled={Boolean(provider)}
                onChange={(value) => updateField("id", value)}
                error={invalid?.field === "id" ? invalid.message : undefined}
              />
            </Field>
          </div>
          <Field className="gap-1.5">
            <div className="flex items-center gap-1">
              <FieldLabel htmlFor="custom-provider-url">基础 URL</FieldLabel>
              <FieldHelp label="基础 URL 示例">
                填写 OpenAI 兼容服务的基础地址，例如 https://api.example.com/v1 或
                http://localhost:11434/v1。
              </FieldHelp>
            </div>
            <Input
              id="custom-provider-url"
              inputMode="url"
              value={form.baseUrl}
              onChange={(value) => updateField("baseUrl", value)}
              error={invalid?.field === "baseUrl" ? invalid.message : undefined}
            />
          </Field>
          <ProviderApiKeyField
            id="custom-provider-key"
            value={form.apiKey}
            saved={hasSavedApiKey && !replacingApiKey}
            placeholder={hasSavedApiKey ? "输入新的 API 密钥" : "本地服务可留空"}
            optional={!hasSavedApiKey}
            onReplace={() => setReplacingApiKey(true)}
            onChange={(value) => updateField("apiKey", value)}
          />

          <section
            aria-labelledby="custom-provider-models"
            className="border-t border-border/70 pt-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="flex items-center gap-1">
                <h3 id="custom-provider-models" className="text-sm font-medium">
                  模型
                </h3>
                <FieldHelp label="模型配置说明">
                  至少添加一个模型。选择「自动匹配」时，会根据模型 ID
                  查找上下文窗口和最大输出，匹配不到则使用默认值。
                </FieldHelp>
              </div>
              <Button type="button" variant="outline" shape="pill" onClick={addModel}>
                <Plus data-icon="inline-start" />
                添加模型
              </Button>
            </div>
            {invalid?.field === "models" && !invalid.rowKey && (
              <FieldError role="alert">{invalid.message}</FieldError>
            )}
            <div className="divide-y divide-border/70">
              {form.models.map((model, index) => {
                const error = invalid?.rowKey === model.key ? invalid : null
                return (
                  <Collapsible
                    key={model.key}
                    open={openParams.includes(model.key)}
                    onOpenChange={(expanded) =>
                      setOpenParams((current) =>
                        expanded
                          ? [...current, model.key]
                          : current.filter((key) => key !== model.key)
                      )
                    }
                    className="py-3 last:pb-0"
                  >
                    <div className="flex items-start gap-2">
                      <div className="grid min-w-0 flex-1 gap-2 @sm/provider-form:grid-cols-2">
                        <Input
                          value={model.id}
                          aria-label={`模型 ${index + 1} ID`}
                          placeholder="模型 ID"
                          error={error?.modelField === "id" ? error.message : undefined}
                          onChange={(id) => updateModel(model.key, { id })}
                        />
                        <Input
                          value={model.displayName}
                          aria-label={`模型 ${index + 1} 显示名称`}
                          placeholder="显示名称（可选）"
                          onChange={(displayName) => updateModel(model.key, { displayName })}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        shape="circle"
                        aria-label={`删除模型 ${index + 1}`}
                        title={`删除模型 ${index + 1}`}
                        disabled={form.models.length === 1}
                        onClick={() => {
                          setForm((current) => ({
                            ...current,
                            models: current.models.filter((item) => item.key !== model.key),
                          }))
                          setInvalid((current) => (current?.rowKey === model.key ? null : current))
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <CollapsibleTrigger
                      className="mt-1.5 text-muted-foreground"
                      render={<Button variant="ghost" size="sm" shape="pill" />}
                    >
                      模型参数
                      <CollapsibleIndicator />
                    </CollapsibleTrigger>
                    <CollapsibleContent contentClassName="px-1 py-2">
                      <div className="grid gap-3 @sm/provider-form:grid-cols-3">
                        <ModelSelect
                          id={`${model.key}-image`}
                          label="图片输入能力"
                          options={IMAGE_SUPPORT_OPTIONS}
                          value={model.imageInputSupport}
                          onChange={(value) =>
                            updateModel(model.key, {
                              imageInputSupport: value as DesktopInputSupport,
                            })
                          }
                        />
                        <ModelSelect
                          id={`${model.key}-context`}
                          label="上下文窗口"
                          options={limitOptions(CONTEXT_WINDOW_TIERS, model.contextWindow)}
                          value={model.contextWindow}
                          automatic
                          error={error?.modelField === "contextWindow" ? error.message : undefined}
                          onChange={(contextWindow) => updateModel(model.key, { contextWindow })}
                        />
                        <ModelSelect
                          id={`${model.key}-output`}
                          label="最大输出"
                          options={limitOptions(MAX_OUTPUT_TIERS, model.maxOutputTokens)}
                          value={model.maxOutputTokens}
                          automatic
                          error={
                            error?.modelField === "maxOutputTokens" ? error.message : undefined
                          }
                          onChange={(maxOutputTokens) =>
                            updateModel(model.key, { maxOutputTokens })
                          }
                        />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          </section>

          <div className="border-t border-border/70 pt-3">
            <RequestHeaderEditor
              rows={form.headers}
              error={invalid?.headerError}
              onChange={(headers) => {
                setInvalid((current) => (current?.field === "headers" ? null : current))
                setForm((current) => ({ ...current, headers }))
              }}
              onAddRow={() => {
                const key = `new-header-${nextRowId.current++}`
                setForm((current) => ({
                  ...current,
                  headers: [...current.headers, { key, name: "", value: "" }],
                }))
              }}
            />
          </div>
        </FieldGroup>
      </ProviderDialogForm>
    </Dialog>
  )
}

function ModelSelect({
  id,
  label,
  options,
  value,
  automatic,
  error,
  onChange,
}: {
  id: string
  label: string
  options: LimitOption[]
  value: string
  automatic?: boolean
  error?: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const items = automatic ? [{ value: LIMIT_AUTO, label: "自动匹配" }, ...options] : options
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={automatic && !value.trim() ? LIMIT_AUTO : value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next === LIMIT_AUTO ? "" : next)
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="max-h-[min(18rem,var(--available-height))]"
        >
          <SelectGroup>
            {items.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && (
        <FieldError id={`${id}-error`} role="alert">
          {error}
        </FieldError>
      )}
    </Field>
  )
}

function emptyModel(key: string): CustomProviderModelRow {
  return {
    key,
    id: "",
    displayName: "",
    imageInputSupport: "unknown",
    contextWindow: "",
    maxOutputTokens: "",
  }
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
      : [emptyModel("model-0")],
    headers: rowsFromHeaders(provider?.headers, provider?.secretHeaderNames),
    secretHeaderNames: provider?.secretHeaderNames,
  }
}
