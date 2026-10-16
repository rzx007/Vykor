import { createRoot } from "react-dom/client"
import { useState } from "react"
import { readPluginUiInstance } from "@vykor/client"
import { useDesktopSessionStore } from "../../src/renderer/src/stores/desktop-session"
import { acceptActiveSessionView, applySessionPartDeltas } from "../../src/renderer/src/stores/desktop-session/session-view-state"
import { createSessionUpdateDeliveryAcknowledger } from "../../src/renderer/src/stores/desktop-session/session-update-delivery"
import { PluginUiProvider } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-provider"
import { PluginUiCard } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card"
import { PluginUiFrame } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-frame"
import { usePluginUiHost } from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-context"
import { selectDraftText, sessionComposerScope } from "../../src/renderer/src/stores/desktop-session/composer-draft-state"
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
const acknowledger = createSessionUpdateDeliveryAcknowledger(window.desktop.sessions)
window.addEventListener("pagehide", () => acknowledger.dispose(), { once: true })
window.desktop.sessions.onUpdated((update) => {
  const current = useDesktopSessionStore.getState()
  if (update.kind === "snapshot") {
    const next = acceptActiveSessionView(update.view.session.id, current.sessionView, update.view)
    if (next !== current.sessionView)
      useDesktopSessionStore.setState({ activeSessionId: update.view.session.id, sessionView: next })
    acknowledger.acknowledge(update, "applied")
  } else {
    const applied = current.sessionView && applySessionPartDeltas(current.sessionView, update)
    if (applied?.kind === "applied") useDesktopSessionStore.setState({ sessionView: applied.view })
    acknowledger.acknowledge(update, applied?.kind === "applied" ? "applied" : "resync-required")
  }
})
function Surface() {
  const [visible, setVisible] = useState(true)
  const view = useDesktopSessionStore((state) => state.sessionView)!
  const host = usePluginUiHost()!
  const sidebar = host.displays.find((display) => display.surface === "session-sidebar")
  const source = view.parts.find((part) => readPluginUiInstance(part.metadata))
  const currentInstance = source && readPluginUiInstance(source.metadata)
  const draftText = useDesktopSessionStore(state => selectDraftText(state, sessionComposerScope(view.session.id)))
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-base font-medium">插件交互验证 · 本地测试数据</h1>
        {source && currentInstance && <PluginUiCard call={source} instance={currentInstance} />}
        <p id="composer-draft">{draftText}</p>
        {sidebar && (
          <aside className="mt-4 border" aria-label="插件交互侧栏">
            <button onClick={() => setVisible(value => !value)}>{visible ? "隐藏侧栏" : "显示侧栏"}</button>
            <button onClick={() => host.close(sidebar.instance.instanceId)}>关闭侧栏</button>
            <div className="h-[540px]" hidden={!visible}>
              <PluginUiFrame key={sidebar.key} display={sidebar} visible={visible} />
            </div>
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
