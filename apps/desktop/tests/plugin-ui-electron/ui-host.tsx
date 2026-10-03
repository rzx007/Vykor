import { createRoot } from "react-dom/client"
import { readPluginUiInstance } from "@vykor/client"
import { useDesktopSessionStore } from "../../src/renderer/src/stores/desktop-session"
import { acceptActiveSessionView } from "../../src/renderer/src/stores/desktop-session/session-view-state"
import { PluginUiProvider } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-provider"
import { PluginUiCard } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card"
import { PluginUiFrame } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-frame"
import { usePluginUiHost } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-provider"
import {
  instance,
  sourcePart,
} from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-fixtures.test-support"
import "../../src/renderer/src/assets/main.css"

useDesktopSessionStore.setState({
  activeSessionId: "session",
  sessionView: {
    cursor: 1,
    syncStatus: "connected",
    session: {
      id: "session",
      cwd: "/fixture",
      model: "fixture",
      title: "测试会话",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    parts: [sourcePart],
    messages: [],
    inputs: [],
    runs: [],
    tasks: [],
    permissions: [],
  },
})
window.desktop.sessions.onUpdated((incoming) => {
  const current = useDesktopSessionStore.getState()
  const next = acceptActiveSessionView(incoming.session.id, current.sessionView, incoming)
  if (next !== current.sessionView) useDesktopSessionStore.setState({ activeSessionId: incoming.session.id, sessionView: next })
})
function Surface() {
  const view = useDesktopSessionStore((state) => state.sessionView)!
  const host = usePluginUiHost()!
  const sidebar = host.displays.find((display) => display.surface === "session-sidebar")
  const source = view.parts.find(part => readPluginUiInstance(part.metadata))
  const currentInstance = source && readPluginUiInstance(source.metadata)
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-base font-medium">插件交互验证 · 本地测试数据</h1>
        {source && currentInstance && <PluginUiCard call={source} instance={currentInstance} />}
        {sidebar && (
          <aside className="mt-4 h-80 border">
            <PluginUiFrame key={sidebar.key} display={sidebar} />
          </aside>
        )}
      </div>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(
  <PluginUiProvider onOpenSidebar={() => {}}>
    <Surface />
  </PluginUiProvider>
)
