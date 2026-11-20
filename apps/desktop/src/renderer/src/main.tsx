import { flushRendererBusinessData } from "./lib/business-data"
import { toast } from "./lib/toast"
import "./assets/main.css"

import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { applyStartupTheme } from "./apply-startup-theme"
import { watchStartupOverlay } from "./startup-overlay"
const App = lazy(() => import("./App"))
const DataRootMaintenance = lazy(() => import("./data-root-maintenance"))

window.desktop.businessData.onFlushRequested(async (freeze) => {
  if (freeze) document.documentElement.inert = true
  try {
    await flushRendererBusinessData()
  } catch (error) {
    toast.error("业务草稿未保存，已停止关闭或迁移，请重试保存。 ")
    throw error
  }
}, () => { document.documentElement.inert = false })
applyStartupTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.desktop.dataRootMaintenance ? <Suspense><DataRootMaintenance /></Suspense> : <Suspense>
    <AppearanceProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </AppearanceProvider>
    </Suspense>}
  </StrictMode>
)

watchStartupOverlay()
