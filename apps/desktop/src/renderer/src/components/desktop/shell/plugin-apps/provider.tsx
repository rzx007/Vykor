import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { PluginAppConfirmation } from "@shared/plugin-app-types"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@renderer/components/ui/alert-dialog"
import { PluginAppPageManager } from "./page-manager"
import { PluginAppFrame } from "./frame"
interface Confirmation { request: PluginAppConfirmation; decide(accepted: boolean): void }
const Context = createContext<PluginAppPageManager | null>(null)
export function usePluginApps(): PluginAppPageManager | null { return useContext(Context) }
const emptyPages: ReturnType<PluginAppPageManager["snapshot"]> = []
const emptySubscribe = () => () => {}
export function usePluginAppPages() {
  const manager = usePluginApps()
  return useSyncExternalStore(manager?.subscribe ?? emptySubscribe, manager?.snapshot ?? (() => emptyPages))
}
export function PluginAppsProvider({ children }: { children: React.ReactNode }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const current = useRef<Confirmation | null>(null)
  const lifetime = useRef(0)
  const [manager] = useState(() => window.desktop?.pluginApps ? new PluginAppPageManager(window.desktop.pluginApps, (request, signal) => new Promise<boolean>(resolve => {
    if (signal.aborted || current.current) { resolve(false); return }
    const decide = (accepted: boolean) => {
      signal.removeEventListener("abort", cancelled)
      if (current.current?.request === request) { current.current = null; setConfirmation(null) }
      resolve(accepted)
    }
    const cancelled = () => decide(false)
    const entry = { request, decide }
    current.current = entry; setConfirmation(entry)
    signal.addEventListener("abort", cancelled, { once: true })
  })) : null)
  const pages = useSyncExternalStore(manager?.subscribe ?? emptySubscribe, manager?.snapshot ?? (() => emptyPages))
  useEffect(() => {
    if (!manager) return
    const generation = ++lifetime.current
    let refreshing = false
    const timer = setInterval(() => {
      if (!refreshing) { refreshing = true; void manager.refresh().finally(() => { refreshing = false }) }
    }, 1500)
    const off = manager.api.onRevoked(({ mountId }) => { void manager.remove(mountId).catch(() => {}) })
    return () => { clearInterval(timer); off(); queueMicrotask(() => { if (lifetime.current === generation) { current.current?.decide(false); void manager.dispose() } }) }
  }, [manager])
  return <Context.Provider value={manager}>
    {children}
    <div data-plugin-app-owner>{pages.map(page => <PluginAppFrame key={page.id} page={page} />)}</div>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) confirmation?.decide(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>确认插件操作</AlertDialogTitle><AlertDialogDescription>{confirmation && ("toolName" in confirmation.request ? `将执行 ${confirmation.request.toolName}。` : `来自 ${confirmation.request.pluginId} 的消息，将发送到原会话 ${confirmation.request.source.sessionId}。`)}</AlertDialogDescription></AlertDialogHeader>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{confirmation && ("toolName" in confirmation.request ? JSON.stringify(confirmation.request.args, null, 2) : confirmation.request.text)}</pre>
        <AlertDialogFooter><AlertDialogCancel onClick={() => confirmation?.decide(false)}>取消</AlertDialogCancel><AlertDialogAction onClick={() => confirmation?.decide(true)}>{confirmation && "toolName" in confirmation.request ? "执行" : "发送"}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Context.Provider>
}
