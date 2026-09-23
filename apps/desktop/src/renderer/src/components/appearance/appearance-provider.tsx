/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import { MotionConfig } from "motion/react"

import {
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  detectLocalFontAvailability,
  repairUnavailableFonts,
} from "./appearance-fonts"
import { resolveAppearanceColors } from "./appearance-colors"
import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreferences,
  type AppearancePreferences,
} from "./appearance-preferences"
import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  type DesktopWindowMaterialPreference,
  type DesktopWindowMaterialState,
} from "@shared/window-material-types"
import {
  readWindowMaterialSnapshot,
  writeWindowMaterialAttributes,
} from "@renderer/apply-startup-theme"

export type AppearanceContextValue = {
  preferences: AppearancePreferences
  resolvedTheme: "light" | "dark"
  resolvedReducedMotion: boolean
  /** 主窗口才有值；宠物窗口等其它入口为 null。 */
  windowMaterial: DesktopWindowMaterialState | null
  fontAvailability: Readonly<Record<string, boolean>>
  saveState: { status: "idle" | "saved" | "error"; message?: string }
  setPreference: <K extends keyof Omit<AppearancePreferences, "version">>(
    key: K,
    value: AppearancePreferences[K]
  ) => boolean
  setWindowMaterial: (preference: DesktopWindowMaterialPreference) => void
  resetAppearance: () => boolean
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined)

const COLOR_PROPERTIES = {
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  ring: "--ring",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarSelected: "--sidebar-selected",
  fileLink: "--file-link",
} as const

function readStoredPreferences(): AppearancePreferences {
  try {
    return parseAppearancePreferences(localStorage.getItem(APPEARANCE_STORAGE_KEY))
  } catch {
    return parseAppearancePreferences(null)
  }
}

function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return fallback
    }
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return
    }

    const mediaQuery = window.matchMedia(query)
    const handleChange = (event: MediaQueryListEvent): void => setMatches(event.matches)
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [query])

  return matches
}

function findFontFamily(options: readonly { id: string; family: string }[], id: string): string {
  return options.find((option) => option.id === id)?.family ?? options[0].family
}

function applyAppearanceToRoot(
  root: HTMLElement,
  preferences: AppearancePreferences,
  resolvedTheme: "light" | "dark",
  resolvedReducedMotion: boolean
): void {
  root.classList.remove("light", "dark")
  root.classList.add(resolvedTheme)
  root.dataset.reducedMotion = String(resolvedReducedMotion)
  root.style.setProperty("--font-sans", findFontFamily(UI_FONT_OPTIONS, preferences.uiFont))
  root.style.setProperty("--font-mono", findFontFamily(CODE_FONT_OPTIONS, preferences.codeFont))
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`)
  root.style.setProperty("--code-font-size", `${preferences.codeFontSize}px`)

  const colors = resolveAppearanceColors(preferences.accent, resolvedTheme)
  for (const [token, property] of Object.entries(COLOR_PROPERTIES)) {
    root.style.setProperty(property, colors[token as keyof typeof colors])
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }): ReactElement {
  const [preferences, setPreferences] = useState(readStoredPreferences)
  const preferencesRef = useRef(preferences)
  const [fontAvailability, setFontAvailability] = useState<Readonly<Record<string, boolean>>>({})
  const [saveState, setSaveState] = useState<AppearanceContextValue["saveState"]>({
    status: "idle",
  })
  const [windowMaterial, setWindowMaterialState] = useState<DesktopWindowMaterialState | null>(
    readWindowMaterialSnapshot
  )
  const windowMaterialRef = useRef(windowMaterial)
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)", false)
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", true)
  const resolvedTheme =
    preferences.theme === "system" ? (systemDark ? "dark" : "light") : preferences.theme
  const resolvedReducedMotion =
    preferences.reducedMotion === "system"
      ? systemReducedMotion
      : preferences.reducedMotion === "on"

  const publishPreferences = useCallback((next: AppearancePreferences) => {
    preferencesRef.current = next
    setPreferences(next)
  }, [])

  const persistPreferences = useCallback(
    (next: AppearancePreferences): boolean => {
      try {
        localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next))
        publishPreferences(next)
        setSaveState({ status: "saved" })
        return true
      } catch {
        setSaveState({ status: "error", message: "无法保存外观设置" })
        return false
      }
    },
    [publishPreferences]
  )

  const setPreference = useCallback<AppearanceContextValue["setPreference"]>(
    (key, value) => {
      const next = parseAppearancePreferences(
        JSON.stringify({ ...preferencesRef.current, [key]: value, version: 1 })
      )
      return persistPreferences(next)
    },
    [persistPreferences]
  )

  const setWindowMaterial = useCallback((preference: DesktopWindowMaterialPreference): void => {
    const previous = windowMaterialRef.current
    // 乐观更新：开关立刻反映选择，原生材质等主进程返回权威状态后再变。
    // 不伪造 active / shell——沿用上一份状态，只改 preference。
    const optimistic = previous ? { ...previous, preference } : null
    windowMaterialRef.current = optimistic
    setWindowMaterialState(optimistic)

    window.desktop.window
      .setMaterial(preference)
      .then((state) => {
        windowMaterialRef.current = state
        setWindowMaterialState(state)
        setSaveState({ status: "saved" })
      })
      .catch(() => {
        windowMaterialRef.current = previous
        setWindowMaterialState(previous)
        setSaveState({ status: "error", message: "无法切换窗口材质" })
      })
  }, [])

  const resetAppearance = useCallback(() => {
    const saved = persistPreferences(parseAppearancePreferences(null))
    if (saved) setWindowMaterial(DEFAULT_WINDOW_MATERIAL_PREFERENCE)
    return saved
  }, [persistPreferences, setWindowMaterial])

  useLayoutEffect(() => {
    applyAppearanceToRoot(
      document.documentElement,
      preferences,
      resolvedTheme,
      resolvedReducedMotion
    )
    if (windowMaterial) writeWindowMaterialAttributes(document.documentElement, windowMaterial)
  }, [preferences, resolvedReducedMotion, resolvedTheme, windowMaterial])

  // renderer 重载（崩溃恢复 / dev 刷新）后 argv 快照会停留在建窗时刻，
  // 这里和主进程对账一次：落盘偏好、实际材质、开关显示才能对得上。
  useEffect(() => {
    if (!windowMaterialRef.current) return

    let disposed = false
    void window.desktop.window
      .getMaterial()
      .then((state) => {
        if (disposed) return
        windowMaterialRef.current = state
        setWindowMaterialState(state)
      })
      .catch(() => {
        // 对账失败不提示：本次渲染继续用 argv 快照，用户切换时仍会拿到权威状态。
      })

    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== APPEARANCE_STORAGE_KEY) {
        return
      }
      publishPreferences(parseAppearancePreferences(event.newValue))
      setSaveState({ status: "idle" })
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [publishPreferences])

  useEffect(() => {
    const fontSet = document.fonts
    if (!fontSet || typeof fontSet.check !== "function") {
      return
    }

    let disposed = false
    void Promise.resolve(fontSet.ready)
      .then(() => detectLocalFontAvailability((query) => fontSet.check(query)))
      .then((availability) => {
        if (disposed) {
          return
        }
        setFontAvailability(availability)
        const repaired = repairUnavailableFonts(preferencesRef.current, availability)
        if (repaired !== preferencesRef.current) {
          persistPreferences(repaired)
        }
      })

    return () => {
      disposed = true
    }
  }, [persistPreferences])

  const value = useMemo<AppearanceContextValue>(
    () => ({
      preferences,
      resolvedTheme,
      resolvedReducedMotion,
      windowMaterial,
      fontAvailability,
      saveState,
      setPreference,
      setWindowMaterial,
      resetAppearance,
    }),
    [
      fontAvailability,
      preferences,
      resetAppearance,
      resolvedReducedMotion,
      resolvedTheme,
      saveState,
      setPreference,
      setWindowMaterial,
      windowMaterial,
    ]
  )

  return (
    <AppearanceContext.Provider value={value}>
      <MotionConfig reducedMotion={resolvedReducedMotion ? "always" : "never"}>
        {children}
      </MotionConfig>
    </AppearanceContext.Provider>
  )
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext)
  if (!context) {
    throw new Error("useAppearance must be used within AppearanceProvider")
  }
  return context
}
