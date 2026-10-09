import { RotateCcw } from "lucide-react"
import { useEffect, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@renderer/components/ui/alert-dialog"
import { Button } from "@renderer/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Separator } from "@renderer/components/ui/separator"
import { Slider } from "@renderer/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { toast } from "@renderer/lib/toast"
import type { DesktopWindowMaterialPreference } from "@shared/window-material-types"

import {
  ACCENT_PRESET_COLORS,
  APPEARANCE_SURFACES,
  resolveAppearanceColors,
} from "./appearance-colors"
import { CODE_FONT_OPTIONS, UI_FONT_OPTIONS, type AppearanceFontOption } from "./appearance-fonts"
import {
  CODE_FONT_SIZE_RANGE,
  DEFAULT_APPEARANCE_PREFERENCES,
  GLASS_STRENGTH_RANGE,
  UI_FONT_SIZE_RANGE,
  normalizeHexColor,
  type AppearancePalette,
  type AccentPresetId,
  type AppearanceTheme,
  type CodeFontId,
  type ReducedMotionPreference,
  type UiFontId,
} from "./appearance-preferences"
import { useAppearance } from "./appearance-provider"
import { ThemePreviewCard } from "./theme-preview-card"
import { windowMaterialDescription } from "./window-material-copy"

const THEME_OPTIONS: readonly AppearanceTheme[] = ["system", "light", "dark"]
const ACCENT_OPTIONS: readonly { id: AccentPresetId; label: string }[] = [
  { id: "neutral", label: "中性" },
  { id: "blue", label: "蓝色" },
  { id: "violet", label: "紫色" },
  { id: "terracotta", label: "陶红" },
  { id: "green", label: "绿色" },
]
const MOTION_OPTIONS: readonly { value: ReducedMotionPreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "on", label: "开启" },
  { value: "off", label: "关闭" },
]
const WINDOW_MATERIAL_OPTIONS: readonly {
  value: DesktopWindowMaterialPreference
  label: string
}[] = [
  { value: "glass", label: "透明磨玻璃" },
  { value: "opaque", label: "不透明" },
]

export function AppearanceSettings(): React.JSX.Element {
  const {
    preferences,
    resolvedTheme,
    windowMaterial,
    fontAvailability,
    saveState,
    setPreference,
    patchPreferences,
    setWindowMaterial,
    resetAppearance,
  } = useAppearance()
  const selectedAccent =
    preferences.accent.kind === "custom"
      ? preferences.accent.value
      : ACCENT_PRESET_COLORS[preferences.accent.id]
  const palette = preferences.colors[resolvedTheme]
  const defaults = APPEARANCE_SURFACES[resolvedTheme]
  const requestedForeground = palette.foreground ?? defaults.foreground
  const colors = resolveAppearanceColors(preferences.accent, resolvedTheme, palette)
  const setPaletteColor = (key: keyof AppearancePalette, value: `#${string}` | null): boolean =>
    setPreference("colors", {
      ...preferences.colors,
      [resolvedTheme]: { ...palette, [key]: value },
    })
  const isWindows = typeof window !== "undefined" && window.electron?.process?.platform === "win32"
  const isMac = typeof window !== "undefined" && window.electron?.process?.platform === "darwin"
  const glassStrength = preferences.glassStrength ?? DEFAULT_APPEARANCE_PREFERENCES.glassStrength
  const commitSingle = <T extends string>(
    values: readonly T[],
    commit: (value: T) => void
  ): void => {
    const value = values[0]
    if (value) commit(value)
  }

  useEffect(() => {
    if (saveState.status !== "error") return
    toast.error("外观设置未保存", saveState.message ?? "请稍后重试。")
  }, [saveState.status, saveState.message])

  return (
    <div data-appearance-settings className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {saveState.status === "saved" ? "已自动保存到当前设备" : "更改会即时预览并自动保存"}
        </p>
        <ResetAppearanceDialog onReset={resetAppearance} />
      </div>

      <AppearanceSection title="模式">
        <Button variant="ghost" className="self-end" onClick={() => setPreference("theme", DEFAULT_APPEARANCE_PREFERENCES.theme)}>恢复默认主题</Button>
        <FieldGroup>
          <Field>
            <FieldLabel className="sr-only">主题</FieldLabel>
            <ToggleGroup
              aria-label="主题"
              variant="outline"
              value={[preferences.theme]}
              onValueChange={(values) =>
                commitSingle(values as AppearanceTheme[], (theme) => setPreference("theme", theme))
              }
              className="grid w-full grid-cols-1 items-stretch sm:grid-cols-3"
            >
              {THEME_OPTIONS.map((theme) => (
                <ToggleGroupItem
                  key={theme}
                  value={theme}
                  aria-label={`${theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}主题`}
                  className="h-auto min-w-0 items-stretch p-2"
                >
                  <ThemePreviewCard
                    theme={theme}
                    selected={preferences.theme === theme}
                    preferences={preferences}
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </AppearanceSection>

      {windowMaterial ? (
        <AppearanceSection title="窗口">
          <FieldGroup>
            <Field orientation="responsive">
              <FieldContent>
                <FieldTitle id="window-material-label">窗口背景</FieldTitle>
                <FieldDescription>{windowMaterialDescription(windowMaterial)}</FieldDescription>
              </FieldContent>
              <ToggleGroup
                aria-labelledby="window-material-label"
                variant="outline"
                value={[windowMaterial.preference]}
                onValueChange={(values) =>
                  commitSingle(values as DesktopWindowMaterialPreference[], (value) =>
                    setWindowMaterial(value)
                  )
                }
              >
                {WINDOW_MATERIAL_OPTIONS.map(({ value, label }) => (
                  <ToggleGroupItem key={value} value={value} aria-label={`${label}窗口背景`}>
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            {isWindows || isMac ? (
              <Field orientation="responsive" data-disabled={windowMaterial.active !== "glass"}>
                <FieldContent>
                  <FieldTitle>透光强度</FieldTitle>
                  <FieldDescription>
                    {windowMaterial.active === "glass"
                      ? "低一些更安静，高一些更透光。正文不受影响。"
                      : windowMaterial.preference === "opaque"
                        ? "开启透明磨玻璃后可调节。"
                        : "系统透明效果可用时才能调节。"}
                  </FieldDescription>
                </FieldContent>
                <div className="flex w-full max-w-72 items-center gap-3">
                  <span className="text-xs text-muted-foreground">弱</span>
                  <Slider
                    aria-label="透光强度"
                    min={GLASS_STRENGTH_RANGE.min}
                    max={GLASS_STRENGTH_RANGE.max}
                    step={5}
                    value={glassStrength}
                    disabled={windowMaterial.active !== "glass"}
                    onValueChange={(value) => {
                      const next = Array.isArray(value) ? value[0] : value
                      if (typeof next === "number" && Number.isFinite(next))
                        setPreference("glassStrength", next)
                    }}
                    className="min-w-32 flex-1"
                  />
                  <span className="text-xs text-muted-foreground">强</span>
                  <output className="text-ui-caption w-9 shrink-0 text-right tabular-nums">
                    {glassStrength}%
                  </output>
                </div>
              </Field>
            ) : null}
          </FieldGroup>
        </AppearanceSection>
      ) : null}

      <AppearanceSection title="颜色">
        <Button variant="ghost" className="self-end" onClick={() => patchPreferences({ accent: DEFAULT_APPEARANCE_PREFERENCES.accent, colors: DEFAULT_APPEARANCE_PREFERENCES.colors })}>恢复默认颜色</Button>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>强调色</FieldTitle>
              <FieldDescription>用于主要操作、链接和键盘焦点。</FieldDescription>
            </FieldContent>
            <ToggleGroup
              aria-label="预设强调色"
              variant="outline"
              value={preferences.accent.kind === "preset" ? [preferences.accent.id] : []}
              onValueChange={(values) =>
                commitSingle(values as AccentPresetId[], (id) =>
                  setPreference("accent", { kind: "preset", id })
                )
              }
            >
              {ACCENT_OPTIONS.map(({ id, label }) => (
                <ToggleGroupItem key={id} value={id} aria-label={`${label}强调色`}>
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-full border border-border"
                    style={{ backgroundColor: ACCENT_PRESET_COLORS[id] }}
                  />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Separator />
          <CustomColorField
            id="appearance-custom-color"
            label="自定义强调色"
            description="输入六位颜色值，或打开选色板。列表选中与悬停底色由背景派生。"
            initialColor={selectedAccent}
            onChange={(value) => setPreference("accent", { kind: "custom", value })}
          />
          <Separator />
          <FieldDescription>
            正在调整{resolvedTheme === "light" ? "浅色" : "深色"}模式的颜色。切换模式可分别设置。
          </FieldDescription>
          <CustomColorField
            key={`background-${resolvedTheme}`}
            id="appearance-background-color"
            label="自定义背景色"
            description="工作区直接使用此色，侧栏、浮层和边框随之调整。"
            initialColor={palette.background ?? defaults.background}
            onChange={(value) => setPaletteColor("background", value)}
            onReset={() => setPaletteColor("background", null)}
            isCustom={palette.background !== null}
          />
          <Separator />
          <CustomColorField
            key={`foreground-${resolvedTheme}`}
            id="appearance-foreground-color"
            label="自定义前景色"
            description="正文、控件与侧栏文字共用此色，按层级调整深浅。"
            initialColor={requestedForeground}
            onChange={(value) => setPaletteColor("foreground", value)}
            onReset={() => setPaletteColor("foreground", null)}
            isCustom={palette.foreground !== null}
          />
          {colors.foreground !== requestedForeground ? (
            <FieldDescription role="status">
              前景与背景过于接近，已提高文字对比度，实际文字颜色为 {colors.foreground}。
            </FieldDescription>
          ) : null}
        </FieldGroup>
      </AppearanceSection>

      <AppearanceSection title="字体">
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={() => patchPreferences({ uiFont: DEFAULT_APPEARANCE_PREFERENCES.uiFont, codeFont: DEFAULT_APPEARANCE_PREFERENCES.codeFont })}>恢复默认字体</Button><Button variant="ghost" onClick={() => patchPreferences({ uiFontSize: DEFAULT_APPEARANCE_PREFERENCES.uiFontSize, codeFontSize: DEFAULT_APPEARANCE_PREFERENCES.codeFontSize })}>恢复默认字号</Button></div>
        <FieldGroup>
          <FontSelect
            label="界面字体"
            description="用于导航、设置、对话和其他界面文字。"
            value={preferences.uiFont}
            options={UI_FONT_OPTIONS}
            availability={fontAvailability}
            onChange={(value) => setPreference("uiFont", value)}
            onReset={() => setPreference("uiFont", DEFAULT_APPEARANCE_PREFERENCES.uiFont)}
          />
          <Separator />
          <FontSelect
            label="代码字体"
            description="用于代码块、差异视图和文件源码预览。"
            value={preferences.codeFont}
            options={CODE_FONT_OPTIONS}
            availability={fontAvailability}
            onChange={(value) => setPreference("codeFont", value)}
            onReset={() => setPreference("codeFont", DEFAULT_APPEARANCE_PREFERENCES.codeFont)}
          />
          <Separator />
          <FontSizeControl
            label="界面字号"
            value={preferences.uiFontSize}
            range={UI_FONT_SIZE_RANGE}
            onChange={(value) => setPreference("uiFontSize", value)}
            onReset={() => setPreference("uiFontSize", DEFAULT_APPEARANCE_PREFERENCES.uiFontSize)}
          />
          <Separator />
          <FontSizeControl
            label="代码字号"
            value={preferences.codeFontSize}
            range={CODE_FONT_SIZE_RANGE}
            onChange={(value) => setPreference("codeFontSize", value)}
            onReset={() => setPreference("codeFontSize", DEFAULT_APPEARANCE_PREFERENCES.codeFontSize)}
          />
        </FieldGroup>
      </AppearanceSection>

      <AppearanceSection title="动效">
        <Button variant="ghost" className="self-end" onClick={() => setPreference("reducedMotion", DEFAULT_APPEARANCE_PREFERENCES.reducedMotion)}>恢复默认动效</Button>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle id="reduced-motion-label">减少动态效果</FieldTitle>
              <FieldDescription>减少页面切换和内容展开时的动画。</FieldDescription>
            </FieldContent>
            <ToggleGroup
              aria-labelledby="reduced-motion-label"
              variant="outline"
              value={[preferences.reducedMotion]}
              onValueChange={(values) =>
                commitSingle(values as ReducedMotionPreference[], (value) =>
                  setPreference("reducedMotion", value)
                )
              }
            >
              {MOTION_OPTIONS.map(({ value, label }) => (
                <ToggleGroupItem key={value} value={value}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </AppearanceSection>
    </div>
  )
}

function CustomColorField({
  id,
  label,
  description,
  initialColor,
  onChange,
  onReset,
  isCustom,
}: {
  id: string
  label: string
  description: string
  initialColor: string
  onChange: (value: `#${string}`) => boolean
  onReset?: () => boolean
  isCustom?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState({ savedColor: initialColor, value: initialColor })
  // 外部设置改变时同步草稿，保留输入节点与焦点，也不需要渲染后的额外同步。
  if (draft.savedColor !== initialColor) {
    setDraft({ savedColor: initialColor, value: initialColor })
  }
  const customColor = draft.savedColor === initialColor ? draft.value : initialColor
  const setCustomColor = (value: string): void => setDraft({ savedColor: initialColor, value })
  const normalizedCustomColor = normalizeHexColor(customColor)
  const customColorInvalid = normalizedCustomColor === null

  const handleCommit = (value: string): void => {
    setCustomColor(value)
    const normalized = normalizeHexColor(value)
    if (normalized && !onChange(normalized)) setCustomColor(initialColor)
  }

  return (
    <Field orientation="responsive" data-invalid={customColorInvalid || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label.replace("自定义", "")}</FieldLabel>
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
        {customColorInvalid ? (
          <FieldError id={`${id}-error`}>请输入完整的六位颜色值，例如 #006AFF。</FieldError>
        ) : null}
      </FieldContent>
      <div className="flex w-full max-w-52 items-center gap-2">
        <label
          htmlFor={`${id}-picker`}
          className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
          style={{ backgroundColor: normalizedCustomColor ?? initialColor }}
          title="打开选色板"
        >
          <input
            id={`${id}-picker`}
            type="color"
            aria-label={`${label}选色板`}
            aria-describedby={`${id}-description`}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            value={normalizedCustomColor ?? initialColor}
            onChange={(event) => handleCommit(event.target.value.toUpperCase())}
          />
        </label>
        <Input
          id={id}
          aria-label={label}
          aria-describedby={
            customColorInvalid ? `${id}-description ${id}-error` : `${id}-description`
          }
          aria-invalid={customColorInvalid || undefined}
          value={customColor}
          maxLength={7}
          spellCheck={false}
          className="font-mono uppercase"
          onChange={(event) => handleCommit(event.target.value)}
        />
        {onReset ? (
          <Button
            variant="ghost"
            size="icon-sm"
            shape="circle"
            aria-label={`恢复默认${label.replace("自定义", "")}`}
            title="恢复默认颜色"
            disabled={!isCustom}
            onClick={() => {
              if (onReset()) setCustomColor(initialColor)
            }}
          >
            <RotateCcw />
          </Button>
        ) : null}
      </div>
    </Field>
  )
}

function AppearanceSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`appearance-${title}`}>
      <h2 id={`appearance-${title}`} className="font-heading text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function FontSelect<Id extends UiFontId | CodeFontId>({
  label,
  description,
  value,
  options,
  availability,
  onChange,
  onReset,
}: {
  label: string
  description: string
  value: Id
  options: readonly AppearanceFontOption<Id>[]
  availability: Readonly<Record<string, boolean>>
  onChange: (value: Id) => void
  onReset: () => boolean
}): React.JSX.Element {
  const items = options.map((option) => ({ label: option.label, value: option.id }))
  const selected = options.find((option) => option.id === value)

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
        <Button variant="ghost" size="sm" onClick={onReset} aria-label={`恢复默认${label}`}>恢复默认</Button>
      </FieldContent>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next as Id)
        }}
      >
        <SelectTrigger aria-label={label} className="w-full max-w-52">
          <SelectValue>{selected?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} side="bottom">
          <SelectGroup>
            <SelectLabel>推荐</SelectLabel>
            {options
              .filter((option) => option.source !== "local")
              .map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
          </SelectGroup>
          <SelectGroup>
            <SelectLabel>本机字体</SelectLabel>
            {options
              .filter((option) => option.source === "local")
              .map((option) => {
                const unavailable = availability[option.id] === false
                return (
                  <SelectItem key={option.id} value={option.id} disabled={unavailable}>
                    {option.label}
                    {unavailable ? "（本机未安装）" : null}
                  </SelectItem>
                )
              })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function FontSizeControl({
  label,
  value,
  range,
  onChange,
  onReset,
}: {
  label: string
  value: number
  range: { min: number; max: number }
  onChange: (value: number) => void
  onReset: () => boolean
}): React.JSX.Element {
  const commit = (next: number | readonly number[]): void => {
    const candidate = Array.isArray(next) ? next[0] : next
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return
    onChange(Math.min(range.max, Math.max(range.min, Math.round(candidate))))
  }

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>
          范围 {range.min}–{range.max} px。
        </FieldDescription>
        <Button variant="ghost" size="sm" onClick={onReset} aria-label={`恢复默认${label}`}>恢复默认</Button>
      </FieldContent>
      <div className="flex w-full max-w-72 items-center gap-3">
        <Slider
          aria-label={label}
          min={range.min}
          max={range.max}
          step={1}
          value={value}
          onValueChange={commit}
          className="min-w-32 flex-1"
        />
        <Input
          aria-label={`${label}数值`}
          type="number"
          min={range.min}
          max={range.max}
          step={1}
          value={value}
          onChange={(event) => commit(event.target.valueAsNumber)}
          className="w-18 text-right tabular-nums"
        />
        <span className="text-xs text-muted-foreground">px</span>
      </div>
    </Field>
  )
}

function ResetAppearanceDialog({ onReset }: { onReset: () => boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        <RotateCcw data-icon="inline-start" />
        恢复默认
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>恢复默认外观？</AlertDialogTitle>
          <AlertDialogDescription>
            主题、颜色、字体、字号、动效和窗口材质都会恢复为默认值，并立即应用到当前设备。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (onReset()) setOpen(false)
            }}
          >
            确认恢复
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
