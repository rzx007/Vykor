import { parsePluginUiAppearance, type PluginUiAppearance } from "@vykor/client"

/** Read the applied renderer values; the main process has no CSS or theme defaults. */
export function readPluginUiAppearance(): PluginUiAppearance {
  const neutral: PluginUiAppearance = {
    theme: "light",
    colors: {
      background: "#ffffff",
      foreground: "#202020",
      muted: "#eeeeee",
      mutedForeground: "#606060",
      primary: "#404040",
      primaryForeground: "#ffffff",
      accent: "#e8e8e8",
      border: "#cccccc",
      destructive: "#b00020",
    },
    fontFamily: "sans-serif",
    fontSizePx: 14,
    reducedMotion: false,
  }
  try {
    const root = document.documentElement
    const css = getComputedStyle(root)
    const colors = Object.fromEntries(
      Object.keys(neutral.colors).map((key) => {
        const variable = "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())
        const value = css.getPropertyValue(variable).trim().replace(/\s+/g, " ")
        if (!value || /var\s*\(/i.test(value)) throw new Error("Unresolved CSS color")
        return [key, value]
      })
    )
    return parsePluginUiAppearance({
      theme: root.classList.contains("dark") ? "dark" : "light",
      colors,
      fontFamily: (css.getPropertyValue("--font-sans").trim() || css.fontFamily).replace(
        /\s+/g,
        " "
      ),
      fontSizePx: parseFloat(css.getPropertyValue("--ui-font-size").trim() || css.fontSize),
      reducedMotion: root.dataset.reducedMotion === "true",
    })
  } catch {
    return neutral
  }
}
