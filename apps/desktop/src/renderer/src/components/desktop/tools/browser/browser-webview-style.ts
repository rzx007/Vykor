type BrowserScrollbarTheme = "light" | "dark"

export function buildBrowserScrollbarCss(theme: BrowserScrollbarTheme): string {
  const foreground = theme === "light" ? "20 27 33" : "245 247 249"
  const idleOpacity = theme === "light" ? "8%" : "10%"
  const hoverOpacity = theme === "light" ? "16%" : "18%"

  return `
    :root { color-scheme: ${theme}; }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgb(${foreground} / ${idleOpacity}) transparent;
    }
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track,
    *::-webkit-scrollbar-corner { background: transparent; }
    *::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
    *::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: rgb(${foreground} / ${idleOpacity});
      background-clip: content-box;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgb(${foreground} / ${hoverOpacity});
      background-clip: content-box;
    }
  `
}
