import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider, useAppearance } from "../../src/renderer/src/components/appearance/appearance-provider"
import { BrowserTool, type BrowserToolTab } from "../../src/renderer/src/components/desktop/tools/browser-tool"
import "./ui-host.css"

function Preview() {
  const appearance = useAppearance()
  Object.assign(window, { setAnnotationTestTheme: (theme: "light" | "dark") => appearance.setPreference("theme", theme) })
  const url = new URLSearchParams(location.search).get("page")!
  const [tab, setTab] = useState<BrowserToolTab>({ id: "qa-browser", title: "批注检查", url, input: url, loading: true, canGoBack: false, canGoForward: false })
  return <main className="relative h-screen w-screen"><BrowserTool tab={tab} active visible onUpdate={patch => setTab(previous => ({ ...previous, ...patch }))} /></main>
}
createRoot(document.getElementById("root")!).render(<AppearanceProvider><Preview /></AppearanceProvider>)
