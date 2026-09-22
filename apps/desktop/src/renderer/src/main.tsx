import "./assets/main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { applyStartupTheme } from "./apply-startup-theme"
import { watchStartupOverlay } from "./startup-overlay"
import App from "./App"

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
