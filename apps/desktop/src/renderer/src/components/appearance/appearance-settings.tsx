import { useEffect, useState } from "react"

import { SettingsResetButton } from "@renderer/components/desktop/settings-page/shared/settings-reset-button"
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerContent,
  ColorPickerHexInput,
  ColorPickerHue,
  ColorPickerTrigger,
} from "@renderer/components/motion/color-picker"
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
import { Switch } from "@renderer/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { toast } from "@renderer/lib/toast"
import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  type DesktopWindowMaterialPreference,
} from "@shared/window-material-types"

import {
  ACCENT_PRESET_COLORS,
  APPEARANCE_SURFACES,
  resolveAppearanceColors,
  resolveAccentColor,
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
const SCALAR_PREFERENCES = [
  "theme",
  "uiFont",
  "codeFont",
  "uiFontSize",
  "codeFontSize",
  "reducedMotion",
  "streamingTextAnimation",
  "glassStrength",
] as const
const PALETTE_COLORS = ["background", "foreground"] as const
const COLOR_MODES = ["light", "dark"] as const
const defaultPreferences = DEFAULT_APPEARANCE_PREFERENCES
const defaultAccent = resolveAccentColor(defaultPreferences.accent)

function defaultPaletteColor(theme: (typeof COLOR_MODES)[number], key: keyof AppearancePalette) {
  return defaultPreferences.colors[theme][key] ?? APPEARANCE_SURFACES[theme][key]
}

export function AppearanceSettings(): React.JSX.Element {
  const {
    preferences,
    resolvedTheme,
    windowMaterial,
    fontAvailability,
    saveState,
    setPreference,
    setWindowMaterial,
    resetAppearance,
  } = useAppearance()
  const selectedAccent = resolveAccentColor(preferences.accent)
  const accentChanged = selectedAccent !== defaultAccent
  const resetAccent = () => setPreference("accent", defaultPreferences.accent)
  const palette = preferences.colors[resolvedTheme]
  const requestedForeground = palette.foreground ?? defaultPaletteColor(resolvedTheme, "foreground")
  const colors = resolveAppearanceColors(preferences.accent, resolvedTheme, palette)
  const paletteColorChanged = (theme: (typeof COLOR_MODES)[number], key: keyof AppearancePalette) => {
    const defaultColor = defaultPaletteColor(theme, key)
    return (preferences.colors[theme][key] ?? defaultColor) !== defaultColor
  }
  const setPaletteColor = (key: keyof AppearancePalette, value: `#${string}` | null): boolean => {
    const savedValue = value === defaultPaletteColor(resolvedTheme, key)
      ? defaultPreferences.colors[resolvedTheme][key]
      : value
    return setPreference("colors", {
      ...preferences.colors,
      [resolvedTheme]: { ...palette, [key]: savedValue },
    })
  }
  const isWindows = typeof window !== "undefined" && window.electron?.process?.platform === "win32"
  const isMac = typeof window !== "undefined" && window.electron?.process?.platform === "darwin"
  // Linux 没有系统提供的窗口材质，主进程永远解析成不透明档，所以干脆不展示这一组设置。
  const isLinux = typeof window !== "undefined" && window.electron?.process?.platform === "linux"
  const glassStrength = preferences.glassStrength ?? defaultPreferences.glassStrength
  const windowMaterialChanged =
    windowMaterial !== null && windowMaterial.preference !== DEFAULT_WINDOW_MATERIAL_PREFERENCE
  const preferenceChanged = (key: (typeof SCALAR_PREFERENCES)[number]) =>
    (preferences[key] ?? defaultPreferences[key]) !== defaultPreferences[key]
  const resetPreference = (key: (typeof SCALAR_PREFERENCES)[number]) =>
    preferenceChanged(key) ? () => setPreference(key, defaultPreferences[key]) : undefined
  const resetPaletteColor = (key: keyof AppearancePalette) =>
    paletteColorChanged(resolvedTheme, key)
      ? () => setPaletteColor(key, defaultPreferences.colors[resolvedTheme][key])
      : undefined
  const hasChanges =
    SCALAR_PREFERENCES.some(preferenceChanged) ||
    windowMaterialChanged ||
    accentChanged ||
    COLOR_MODES.some((theme) => PALETTE_COLORS.some((key) => paletteColorChanged(theme, key)))

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
        {hasChanges ? <ResetAppearanceDialog onReset={resetAppearance} /> : null}
      </div>

      <AppearanceSection
        title="模式"
        titleAction={<SettingsResetButton label="恢复默认主题" onReset={resetPreference("theme")} />}
      >
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

      {windowMaterial && !isLinux ? (
        <AppearanceSection title="窗口">
          <FieldGroup>
            <Field orientation="responsive">
              <FieldContent>
                <div className="flex items-center gap-1">
                  <FieldTitle id="window-material-label">
                    {isWindows ? "半透明侧边栏" : "窗口背景"}
                  </FieldTitle>
                  {!isWindows && windowMaterialChanged ? (
                    <SettingsResetButton
                      label="恢复默认窗口背景"
                      onReset={() => setWindowMaterial(DEFAULT_WINDOW_MATERIAL_PREFERENCE)}
                    />
                  ) : null}
                </div>
                <FieldDescription id="window-material-description">
                  {windowMaterialDescription(windowMaterial, isWindows ? "win32" : undefined)}
                </FieldDescription>
              </FieldContent>
              {isWindows ? (
                <Switch
                  aria-label="半透明侧边栏"
                  aria-describedby="window-material-description"
                  checked={windowMaterial.preference === "glass"}
                  onCheckedChange={(enabled) => setWindowMaterial(enabled ? "glass" : "opaque")}
                />
              ) : (
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
              )}
            </Field>
            {isMac || isWindows ? (
              <Field orientation="responsive" data-disabled={windowMaterial.active !== "glass"}>
                <FieldContent>
                  <div className="flex items-center gap-1">
                    <FieldTitle>透光强度</FieldTitle>
                    <SettingsResetButton
                      label="恢复默认透光强度"
                      onReset={resetPreference("glassStrength")}
                    />
                  </div>
                  <FieldDescription>
                    {windowMaterial.active === "glass"
                      ? "低一些更安静，高一些更透光。正文不受影响。"
                      : windowMaterial.preference === "opaque"
                        ? `开启${isWindows ? "半透明侧边栏" : "透明磨玻璃"}后可调节。`
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
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <div className="flex items-center gap-1">
                <FieldTitle>强调色</FieldTitle>
                {preferences.accent.kind === "preset" && accentChanged ? (
                  <SettingsResetButton label="恢复默认强调色" onReset={resetAccent} />
                ) : null}
              </div>
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
            title="自定义强调色"
            description="输入六位颜色值，或打开选色板。列表选中与悬停底色由背景派生。"
            initialColor={selectedAccent}
            onChange={(value) =>
              setPreference(
                "accent",
                value === defaultAccent ? defaultPreferences.accent : { kind: "custom", value }
              )
            }
            onReset={preferences.accent.kind === "custom" && accentChanged ? resetAccent : undefined}
          />
          <Separator />
          <FieldDescription>
            正在调整{resolvedTheme === "light" ? "浅色" : "深色"}模式的颜色。切换模式可分别设置。
          </FieldDescription>
          <CustomColorField
            key={`background-${resolvedTheme}`}
            id="appearance-background-color"
            label="自定义背景色"
            title="背景色"
            description="工作区直接使用此色，侧栏、浮层和边框随之调整。"
            initialColor={palette.background ?? defaultPaletteColor(resolvedTheme, "background")}
            onChange={(value) => setPaletteColor("background", value)}
            onReset={resetPaletteColor("background")}
          />
          <Separator />
          <CustomColorField
            key={`foreground-${resolvedTheme}`}
            id="appearance-foreground-color"
            label="自定义前景色"
            title="前景色"
            description="正文、控件与侧栏文字共用此色，按层级调整深浅。"
            initialColor={requestedForeground}
            onChange={(value) => setPaletteColor("foreground", value)}
            onReset={resetPaletteColor("foreground")}
          />
          {colors.foreground !== requestedForeground ? (
            <FieldDescription role="status">
              前景与背景过于接近，已提高文字对比度，实际文字颜色为 {colors.foreground}。
            </FieldDescription>
          ) : null}
        </FieldGroup>
      </AppearanceSection>

      <AppearanceSection title="字体">
        <FieldGroup>
          <FontSelect
            label="界面字体"
            description="用于导航、设置、对话和其他界面文字。"
            value={preferences.uiFont}
            options={UI_FONT_OPTIONS}
            availability={fontAvailability}
            onChange={(value) => setPreference("uiFont", value)}
            onReset={resetPreference("uiFont")}
          />
          <Separator />
          <FontSelect
            label="代码字体"
            description="用于代码块、差异视图和文件源码预览。"
            value={preferences.codeFont}
            options={CODE_FONT_OPTIONS}
            availability={fontAvailability}
            onChange={(value) => setPreference("codeFont", value)}
            onReset={resetPreference("codeFont")}
          />
          <Separator />
          <FontSizeControl
            label="界面字号"
            value={preferences.uiFontSize}
            range={UI_FONT_SIZE_RANGE}
            onChange={(value) => setPreference("uiFontSize", value)}
            onReset={resetPreference("uiFontSize")}
          />
          <Separator />
          <FontSizeControl
            label="代码字号"
            value={preferences.codeFontSize}
            range={CODE_FONT_SIZE_RANGE}
            onChange={(value) => setPreference("codeFontSize", value)}
            onReset={resetPreference("codeFontSize")}
          />
        </FieldGroup>
      </AppearanceSection>

      <AppearanceSection title="动效">
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <div className="flex items-center gap-1">
                <FieldTitle id="reduced-motion-label">减少动态效果</FieldTitle>
                <SettingsResetButton
                  label="恢复默认减少动态效果"
                  onReset={resetPreference("reducedMotion")}
                />
              </div>
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
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="streaming-text-animation">Agent 逐字输出动画</FieldLabel>
              <FieldDescription>新文字逐字淡入；开启减少动态效果时暂停，长回复保留性能保护。</FieldDescription>
            </FieldContent>
            <Switch
              id="streaming-text-animation"
              aria-label="Agent 逐字输出动画"
              checked={preferences.streamingTextAnimation}
              onCheckedChange={(checked) => setPreference("streamingTextAnimation", checked)}
            />
          </Field>
        </FieldGroup>
      </AppearanceSection>
    </div>
  )
}

function CustomColorField({
  id,
  label,
  title,
  description,
  initialColor,
  onChange,
  onReset,
}: {
  id: string
  label: string
  title: string
  description: string
  initialColor: string
  onChange: (value: `#${string}`) => boolean
  onReset?: () => boolean
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
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor={id}>{title}</FieldLabel>
          <SettingsResetButton
            label={`恢复默认${title}`}
            onReset={
              onReset
                ? () => {
                    if (onReset()) setCustomColor(initialColor)
                  }
                : undefined
            }
          />
        </div>
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
        {customColorInvalid ? (
          <FieldError id={`${id}-error`}>请输入完整的六位颜色值，例如 #006AFF。</FieldError>
        ) : null}
      </FieldContent>
      <div className="flex w-full max-w-52 items-center justify-center gap-2">
        <ColorPicker
          aria-label={`${label}选择器`}
          value={normalizedCustomColor ?? initialColor}
          alpha={false}
          onValueChange={handleCommit}
          className="w-fit max-w-none flex-none gap-0"
        >
          <ColorPickerTrigger
            aria-label={`${label}选色板`}
            aria-describedby={`${id}-description`}
            title="打开选色板"
            className="size-7 rounded-full border-0 bg-transparent p-0 hover:border-0 hover:bg-transparent"
          >
            <span className="sr-only">打开选色板</span>
          </ColorPickerTrigger>
          <ColorPickerContent aria-label={`${label}选择器`} align="end">
            <ColorPickerArea label={`${label}饱和度和亮度`} />
            <ColorPickerHue label={`${label}色相`} />
            <ColorPickerHexInput aria-label={`${label}色值`} />
          </ColorPickerContent>
        </ColorPicker>
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
      </div>
    </Field>
  )
}

function AppearanceSection({
  title,
  titleAction,
  children,
}: {
  title: string
  titleAction?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`appearance-${title}`}>
      <div className="flex items-center gap-1">
        <h2 id={`appearance-${title}`} className="font-heading text-lg font-semibold">
          {title}
        </h2>
        {titleAction}
      </div>
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
  onReset?: () => void
}): React.JSX.Element {
  const items = options.map((option) => ({ label: option.label, value: option.id }))
  const selected = options.find((option) => option.id === value)

  return (
    <Field orientation="responsive">
      <FieldContent>
        <div className="flex items-center gap-1">
          <FieldTitle>{label}</FieldTitle>
          <SettingsResetButton label={`恢复默认${label}`} onReset={onReset} />
        </div>
        <FieldDescription>{description}</FieldDescription>
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
  onReset?: () => void
}): React.JSX.Element {
  const commit = (next: number | readonly number[]): void => {
    const candidate = Array.isArray(next) ? next[0] : next
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return
    onChange(Math.min(range.max, Math.max(range.min, Math.round(candidate))))
  }

  return (
    <Field orientation="responsive">
      <FieldContent>
        <div className="flex items-center gap-1">
          <FieldTitle>{label}</FieldTitle>
          <SettingsResetButton label={`恢复默认${label}`} onReset={onReset} />
        </div>
        <FieldDescription>
          范围 {range.min}–{range.max} px。
        </FieldDescription>
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
      <AlertDialogTrigger render={<Button variant="outline" size="sm" shape="pill" />}>
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
