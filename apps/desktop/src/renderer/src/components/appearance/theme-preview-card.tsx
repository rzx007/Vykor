import { Check } from "lucide-react"

import { cn } from "@renderer/lib/utils"

import { resolveAppearanceColors } from "./appearance-colors"
import type { AppearancePreferences, AppearanceTheme } from "./appearance-preferences"

const THEME_LABELS: Record<AppearanceTheme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
}

export function ThemePreviewCard({
  theme,
  selected,
  preferences,
}: {
  theme: AppearanceTheme
  selected: boolean
  preferences: AppearancePreferences
}): React.JSX.Element {
  const modes: readonly ("light" | "dark")[] = theme === "system" ? ["light", "dark"] : [theme]

  return (
    <span className="flex w-full flex-col gap-2">
      <span aria-hidden="true" className="flex h-24 w-full overflow-hidden rounded-md border">
        {modes.map((mode) => {
          const colors = resolveAppearanceColors(preferences.accent, mode, preferences.colors[mode])
          return (
            <span
              key={mode}
              className="flex min-w-0 flex-1"
              style={{ backgroundColor: colors.background }}
            >
              <span
                className="flex w-[32%] shrink-0 flex-col gap-2 px-1.5 py-3"
                style={{ backgroundColor: colors.shellSolid }}
              >
                <span
                  className="h-1.5 w-3/4 rounded-full"
                  style={{ backgroundColor: colors.sidebarForeground }}
                />
                <span
                  className="h-3 w-full rounded-sm"
                  style={{ backgroundColor: colors.sidebarSelected }}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-2 p-3">
                <span
                  className="h-1.5 w-3/5 rounded-full"
                  style={{ backgroundColor: colors.foreground }}
                />
                <span
                  className="h-1.5 w-full rounded-full"
                  style={{ backgroundColor: colors.mutedForeground }}
                />
                <span
                  className="h-1.5 w-4/5 rounded-full"
                  style={{ backgroundColor: colors.mutedForeground }}
                />
                <span
                  className="mt-auto h-2 w-1/4 self-end rounded-full"
                  style={{ backgroundColor: colors.primary }}
                />
              </span>
            </span>
          )
        })}
      </span>
      <span className="flex items-center justify-between gap-2 text-sm">
        <span>{THEME_LABELS[theme]}</span>
        <Check
          aria-hidden="true"
          className={cn("transition-opacity", selected ? "opacity-100" : "opacity-0")}
        />
      </span>
    </span>
  )
}
