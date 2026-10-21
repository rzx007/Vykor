import { createRoot } from "react-dom/client"
import { useState } from "react"
import { PluginAppsProvider, usePluginApps, usePluginAppPages } from "../../src/renderer/src/components/desktop/shell/plugin-apps/provider"
import { PluginAppAnchor } from "../../src/renderer/src/components/desktop/shell/plugin-apps/panel"
import { PluginAppComposerContext } from "../../src/renderer/src/components/desktop/shell/plugin-apps/composer-context"
import { pluginAppModelContexts } from "../../src/renderer/src/components/desktop/shell/plugin-apps/plugin-app-model-context"
import "../../src/renderer/src/assets/main.css"
declare global { interface Window { fixtureOpen(sessionId: string, pluginId: string, surfaceId?: string): Promise<string>; fixtureMount(source: {sessionId: string; appId: string}): Promise<string>; fixtureVisible(visible: boolean): void; fixtureSelect(sessionId: string): void; fixtureRelease(): Promise<void>; fixtureClose(): Promise<void>; fixtureSavedWindow?: Window | null; fixturePush(result: unknown): void } }
function Surface() {
  const manager = usePluginApps()!, pages = usePluginAppPages()
  const [visible, setVisible] = useState(true), [session, setSession] = useState("app-session")
  window.fixtureVisible = setVisible; window.fixtureSelect = setSession
  window.fixtureOpen = async (sessionId, pluginId, surfaceId = "editor") => (await manager.open(sessionId, pluginId, surfaceId, "Editor")).id
  window.fixtureMount = async source => (await manager.mount(source, "Editor")).id
  Object.assign(window, { fixtureContextIds: () => pluginAppModelContexts.forSession(session).map(item => item.id),
    fixtureOpenResult: async (sessionId: string, partId: string) => (await manager.openToolResult(sessionId, partId)).id })
  window.fixtureRelease = () => manager.dispose()
  const page = pages.find(item => item.controller.state.source.sessionId === session)
  window.fixturePush = result => page?.transport?.queueInitial({ arguments: {}, result })
  window.fixtureClose = async () => { if (page) { await page.controller.refresh(); await manager.remove(page.id, true) } }
  return <div style={{ position: "fixed", inset: 0 }}><PluginAppComposerContext sessionId={session} readOnly={false} />{page && <PluginAppAnchor pageId={page.id} visible={visible} />}</div>
}
createRoot(document.getElementById("root")!).render(<PluginAppsProvider><Surface /></PluginAppsProvider>)
