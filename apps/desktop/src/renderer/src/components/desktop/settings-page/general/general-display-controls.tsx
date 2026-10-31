import { useEffect, useState } from "react"
import { DEFAULT_REPLY_STYLE, isReplyStyle, type ReplyStyle } from "@vykor/application-client"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Switch } from "@renderer/components/ui/switch"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import {
  isDesktopWorkStyle,
  isDesktopLinkOpeningMode,
  type DesktopWorkStyle,
  type DesktopLinkOpeningMode,
} from "@shared/settings-types"
import { errorMessage } from "../shared/settings-error-message"

const replyStyleLabels: Record<ReplyStyle, string> = {
  collaborative: "协作",
  direct: "直接",
  explanatory: "讲解",
}

export function LinkOpeningModeControl(): React.JSX.Element {
  const [mode, setMode] = useState<DesktopLinkOpeningMode>("ask")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labels = { ask: "每次询问", builtin: "Vykor 内置浏览器", system: "系统默认浏览器" }

  useEffect(() => {
    let alive = true
    void window.desktop.settings
      .getLinkOpeningMode()
      .then(
        (value) => {
          if (alive) setMode(isDesktopLinkOpeningMode(value) ? value : "ask")
        },
        (failure) => {
          if (alive) setError(errorMessage(failure))
        }
      )
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  async function update(next: DesktopLinkOpeningMode) {
    if (loading || saving || next === mode) return
    const previous = mode
    setMode(next)
    setSaving(true)
    setError(null)
    try {
      setMode(await window.desktop.settings.updateLinkOpeningMode({ linkOpeningMode: next }))
    } catch (failure) {
      setMode(previous)
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={mode}
        disabled={loading || saving}
        onValueChange={(value) => {
          if (isDesktopLinkOpeningMode(value)) void update(value)
        }}
      >
        <SelectTrigger aria-label="消息链接打开方式" className="min-w-44">
          <SelectValue>{labels[mode]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {Object.entries(labels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ReplyStyleControl(): React.JSX.Element {
  const [style, setStyle] = useState<ReplyStyle>(DEFAULT_REPLY_STYLE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setStyle(snapshot.replyStyle)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (nextStyle: ReplyStyle): void => {
    if (loading || saving || nextStyle === style) return
    const previous = style
    setStyle(nextStyle)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateReplyStyle({ replyStyle: nextStyle })
      .then((snapshot) => setStyle(snapshot.replyStyle))
      .catch((saveError: unknown) => {
        setStyle(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={style}
        onValueChange={(value) => {
          if (isReplyStyle(value)) update(value)
        }}
      >
        <SelectTrigger aria-label="回复风格" disabled={loading || saving} className="min-w-28">
          <SelectValue>{replyStyleLabels[style]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {Object.entries(replyStyleLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function WorkStyleControl(): React.JSX.Element {
  const [style, setStyle] = useState<DesktopWorkStyle>("practical")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setStyle(snapshot.workStyle)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (nextStyle: DesktopWorkStyle): void => {
    if (saving || nextStyle === style) return
    const previous = style
    setStyle(nextStyle)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateWorkStyle({ workStyle: nextStyle })
      .then((snapshot) => setStyle(snapshot.workStyle))
      .catch((saveError: unknown) => {
        setStyle(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={style}
        onValueChange={(value) => {
          if (isDesktopWorkStyle(value)) update(value)
        }}
      >
        <SelectTrigger aria-label="进度通知" disabled={loading || saving} className="min-w-28">
          <SelectValue>{style === "practical" ? "关键节点" : "必要时"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="practical">关键节点</SelectItem>
            <SelectItem value="efficient">必要时</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ReasoningVisibilityControl(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setEnabled(snapshot.showReasoning)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: boolean): void => {
    if (saving || next === enabled) return
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateReasoningVisibility({ showReasoning: next })
      .then((snapshot) => setEnabled(snapshot.showReasoning))
      .catch((saveError: unknown) => {
        setEnabled(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        aria-label="思考过程"
        checked={enabled}
        disabled={loading || saving}
        onCheckedChange={update}
      />
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ThemePreferenceControl() {
  const { preferences, setPreference } = useAppearance()
  const [error, setError] = useState("")
  const labels = { system: "跟随系统", light: "浅色", dark: "深色" }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={preferences.theme}
        onValueChange={(value) => {
          if (value !== "system" && value !== "light" && value !== "dark") return
          setError(setPreference("theme", value) ? "" : "主题保存失败，请重新选择。")
        }}
      >
        <SelectTrigger aria-label="界面主题" className="min-w-36">
          <SelectValue>{labels[preferences.theme]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {Object.entries(labels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function BrowserDeveloperControl() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    void window.desktop.settings.snapshot().then(
      (value) => {
        if (alive) setEnabled(value.browserDeveloperMode)
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function update(next: boolean) {
    if (enabled === null || busy) return
    setBusy(true)
    setError("")
    try {
      setEnabled(
        (await window.desktop.settings.updateBrowserDeveloperMode({ enabled: next }))
          .browserDeveloperMode
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        id="general-browser-developer"
        aria-label="浏览器开发者模式"
        checked={enabled === true}
        disabled={enabled === null || busy}
        onCheckedChange={(next) => void update(next)}
      />
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
