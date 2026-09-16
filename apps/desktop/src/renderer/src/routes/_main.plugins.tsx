import { createFileRoute } from "@tanstack/react-router"

import { PluginPage } from "@renderer/components/desktop/plugin-page"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/_main/plugins")({
  beforeLoad: () => useDesktopSessionStore.getState().initialize(),
  component: PluginPage,
})
