import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { PluginAppConfirmation } from "@shared/plugin-app-types"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@renderer/components/ui/alert-dialog"
import { PluginAppPageManager } from "./page-manager"
import { PluginAppFrame } from "./frame"
import type { AppConfirmationSource } from "./controller"
interface Confirmation { request: PluginAppConfirmation; source?: AppConfirmationSource; decide(accepted: boolean): void }
const Context = createContext<PluginAppPageManager | null>(null)
const ConfirmingContext = createContext(false)
export function usePluginAppConfirming(): boolean { return useContext(ConfirmingContext) }
export function usePluginApps(): PluginAppPageManager | null { return useContext(Context) }
const emptyPages: ReturnType<PluginAppPageManager["snapshot"]> = []
const emptySubscribe = () => () => {}
export function usePluginAppPages() {
  const manager = usePluginApps()
  return useSyncExternalStore(manager?.subscribe ?? emptySubscribe, manager?.snapshot ?? (() => emptyPages))
}
export function usePluginAppPanelRequest() {
  const manager = usePluginApps()
  return useSyncExternalStore(manager?.subscribe ?? emptySubscribe, () => manager?.panelRequest ?? null)
}
export function PluginAppsProvider({ children }: { children: React.ReactNode }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const current = useRef<Confirmation | null>(null)
  const lifetime = useRef(0)
  const [manager] = useState(() => window.desktop?.pluginApps ? new PluginAppPageManager(window.desktop.pluginApps, (request, signal, source) => new Promise<boolean>(resolve => {
    if (signal.aborted || current.current) { resolve(false); return }
    const decide = (accepted: boolean) => {
      signal.removeEventListener("abort", cancelled)
      if (current.current?.request === request) { current.current = null; setConfirmation(null) }
      resolve(accepted)
    }
    const cancelled = () => decide(false)
    const entry = { request, source, decide }
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
    <ConfirmingContext.Provider value={!!confirmation}>
    {children}
    </ConfirmingContext.Provider>
    <div data-plugin-app-owner>{pages.map(page => <PluginAppFrame key={page.id} page={page} />)}</div>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) confirmation?.decide(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{confirmation && "toolName" in confirmation.request ? `${confirmation.source?.title ?? "插件应用"} · 确认操作` : "发送到聊天"}</AlertDialogTitle><AlertDialogDescription>{confirmation && ("toolName" in confirmation.request ? `将执行 ${confirmation.request.toolName}，在原会话中记录操作回执。` : `来自 ${confirmation.source?.title ?? confirmation.request.pluginId} 的消息将发送到原会话，由助手继续处理。`)}</AlertDialogDescription></AlertDialogHeader>
        {confirmation?.source?.description && <p className="text-sm text-muted-foreground">{confirmation.source.description}</p>}
        {confirmation?.source && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">来源信息</summary><p className="break-all pt-2">插件：{confirmation.source.pluginId}<br />原会话：{confirmation.source.sessionId}</p></details>}
        {confirmation && ("toolName" in confirmation.request
          ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">操作详情 · {confirmation.request.toolName}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3">{JSON.stringify(confirmation.request.args, null, 2)}</pre></details>
          : <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{confirmation.request.text}</pre>)}
        <AlertDialogFooter><AlertDialogCancel onClick={() => confirmation?.decide(false)}>取消</AlertDialogCancel><AlertDialogAction onClick={() => confirmation?.decide(true)}>{confirmation && "toolName" in confirmation.request ? "执行" : "发送"}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Context.Provider>
}
