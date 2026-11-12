import { flushRendererBusinessData } from "./lib/business-data"
import { toast } from "./lib/toast"
import "./assets/main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { applyStartupTheme } from "./apply-startup-theme"
import { watchStartupOverlay } from "./startup-overlay"
import App from "./App"

window.desktop.businessData.onFlushRequested(async (freeze) => {
  if (freeze) document.documentElement.inert = true
  try {
    await flushRendererBusinessData()
  } catch (error) {
    toast.error("业务草稿未保存，已停止关闭或迁移，请重试保存。 ")
    throw error
  }
})
applyStartupTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppearanceProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </AppearanceProvider>
  </StrictMode>
)

watchStartupOverlay()
