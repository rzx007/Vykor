import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  PluginUiBridgeError,
  readPluginUiInstance,
  type PluginUiInstanceRecord,
  type PluginUiSurface,
} from "@vykor/client"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopSessionView } from "@shared/session-types"
import { PluginUiConfirmation, type PluginUiConfirmationDetails } from "./plugin-ui-confirmation"

export interface PluginUiDisplay {
  key: string
  instance: PluginUiInstanceRecord
  surface: PluginUiSurface
}
interface Host {
  available: boolean
  view: DesktopSessionView | null
  displays: PluginUiDisplay[]
  isCurrent(instanceId: string): boolean
  open(instance: PluginUiInstanceRecord, surface: PluginUiSurface, opener?: HTMLElement): void
  close(instanceId: string, focus?: boolean): void
  confirm(details: PluginUiConfirmationDetails, signal: AbortSignal): Promise<void>
}
const Context = createContext<Host | null>(null)
export const usePluginUiHost = () => useContext(Context)
function hasSource(view: DesktopSessionView | null, instanceId: string): boolean {
  return Boolean(
    view?.parts.some((part) => {
      const source = readPluginUiInstance(part.metadata)
      return (
        source?.instanceId === instanceId &&
        source.sourcePartId === part.id &&
        source.sessionId === view.session.id
      )
    })
  )
}
/** Shares the existing session stream. No polling, extra socket or business state. */
export function PluginUiProvider({
  children,
  onOpenSidebar,
}: {
  children: ReactNode
  onOpenSidebar(): void
}) {
  const view = useDesktopSessionStore((state) => state.sessionView)
  const sessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const [available, setAvailable] = useState(false)
  const [displays, setDisplays] = useState<PluginUiDisplay[]>([])
  const [confirmation, setConfirmation] = useState<PluginUiConfirmationDetails | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const scopeRef = useRef(sessionId)
  scopeRef.current = sessionId
  const availableRef = useRef(available)
  availableRef.current = available
  const openers = useRef(new Map<string, HTMLElement>())
  const pending = useRef<{ instanceId: string; decide(accepted: boolean): void } | null>(null)
  const generation = view?.session.metadata.pluginUiGeneration
  const syncStatus = view?.syncStatus
  const isCurrent = useCallback((id: string) => {
    const current = viewRef.current
    return Boolean(
      current &&
      current.session.id === scopeRef.current &&
      current.syncStatus === "connected" &&
      hasSource(current, id)
    )
  }, [])
  const close = useCallback((id: string, focus = true) => {
    pending.current?.instanceId === id && pending.current.decide(false)
    setDisplays((current) => current.filter((display) => display.instance.instanceId !== id))
    if (focus) {
      const opener = openers.current.get(id)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  const open = useCallback(
    (instance: PluginUiInstanceRecord, surface: PluginUiSurface, opener?: HTMLElement) => {
      if (
        !availableRef.current ||
        !isCurrent(instance.instanceId) ||
        !instance.surfaces.includes(surface)
      )
        return
      pending.current?.instanceId === instance.instanceId && pending.current.decide(false)
      if (opener) openers.current.set(instance.instanceId, opener)
      setDisplays((current) => {
        let next = current.filter(
          (display) =>
            display.instance.instanceId !== instance.instanceId &&
            !(surface === "session-sidebar" && display.surface === surface)
        )
        if (next.length >= 2) {
          const oldest = next.find((display) => display.surface !== "session-sidebar")
          next = next.filter((display) => display !== oldest)
        }
        return [...next, { key: crypto.randomUUID(), instance, surface }]
      })
      if (surface === "session-sidebar") onOpenSidebar()
    },
    [isCurrent, onOpenSidebar]
  )
  const confirm = useCallback(
    (details: PluginUiConfirmationDetails, signal: AbortSignal) => {
      if (signal.aborted || !isCurrent(details.instance.instanceId))
        return Promise.reject(new PluginUiBridgeError("plugin_ui_mount_closed"))
      if (pending.current)
        return Promise.reject(new PluginUiBridgeError("plugin_ui_confirmation_pending"))
      const owned = structuredClone(details)
      return new Promise<void>((resolve, reject) => {
        const finish = (accepted: boolean, code = "plugin_ui_user_cancelled") => {
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          pending.current = null
          setConfirmation(null)
          if (accepted && !signal.aborted && isCurrent(owned.instance.instanceId)) resolve()
          else reject(new PluginUiBridgeError(code))
        }
        const abort = () => finish(false, "plugin_ui_mount_closed")
        const timer = setTimeout(() => finish(false, "plugin_ui_timeout"), 300_000)
        signal.addEventListener("abort", abort, { once: true })
        pending.current = { instanceId: owned.instance.instanceId, decide: finish }
        setConfirmation(owned)
      })
    },
    [isCurrent]
  )
  useEffect(() => {
    let active = true
    setDisplays([])
    pending.current?.decide(false)
    setAvailable(false)
    if (sessionId && syncStatus === "connected")
      void window.desktop?.pluginUi
        ?.capabilities()
        .then((caps) => {
          if (active) setAvailable(caps.available)
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [sessionId, syncStatus, generation])
  useEffect(() => {
    setDisplays((current) => current.filter((display) => isCurrent(display.instance.instanceId)))
    if (pending.current && !isCurrent(pending.current.instanceId)) pending.current.decide(false)
  }, [view, sessionId, isCurrent])
  useEffect(
    () => () => {
      pending.current?.decide(false)
      openers.current.clear()
    },
    []
  )
  return (
    <Context.Provider value={{ available, view, displays, isCurrent, open, close, confirm }}>
      {children}
      <PluginUiConfirmation
        details={confirmation}
        decide={(accepted) => pending.current?.decide(accepted)}
      />
    </Context.Provider>
  )
}
