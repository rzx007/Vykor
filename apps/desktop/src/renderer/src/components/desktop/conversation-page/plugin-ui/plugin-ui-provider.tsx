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
import type { DesktopPluginUiMountResult } from "@shared/plugin-ui-types"
import { PluginUiConfirmation, type PluginUiConfirmationDetails } from "./plugin-ui-confirmation"
import { usePluginUiConversation } from "./use-plugin-ui-conversation"

export interface PluginUiDisplay {
  key: string
  instance: PluginUiInstanceRecord
  surface: PluginUiSurface
}
export interface PluginUiMountLease {
  result: Promise<DesktopPluginUiMountResult>
  release(): Promise<void>
}
interface Host {
  available: boolean
  view: DesktopSessionView | null
  displays: PluginUiDisplay[]
  isCurrent(instanceId: string): boolean
  mount(display: PluginUiDisplay): PluginUiMountLease
  open(
    instance: PluginUiInstanceRecord,
    surface: PluginUiSurface,
    opener?: HTMLElement,
    forceReload?: boolean
  ): void
  close(instanceId: string, focus?: boolean): void
  confirm(details: PluginUiConfirmationDetails, signal: AbortSignal): Promise<void>
  requestConversation: ReturnType<typeof usePluginUiConversation>["request"]
  conversationStatus: ReturnType<typeof usePluginUiConversation>["status"]
  queryConversation: ReturnType<typeof usePluginUiConversation>["query"]
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
  const displaysRef = useRef<PluginUiDisplay[]>([])
  // Pending loads and revocations outlive a Frame, but never retain its DOM or inputs.
  const mounts = useRef(new Map<string, PluginUiMountLease>())
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
  const mount = useCallback((display: PluginUiDisplay): PluginUiMountLease => {
    const id = display.instance.instanceId
    const previous = mounts.current.get(id)
    const api = window.desktop.pluginUi
    let released = false
    let retirement: Promise<void> | undefined
    const lease: PluginUiMountLease = {
      result: (async () => {
        await previous?.release()
        if (released || !isCurrent(id) || !displaysRef.current.some(item => item.key === display.key))
          throw new PluginUiBridgeError("plugin_ui_mount_closed")
        return await api.mount({ sessionId: display.instance.sessionId, instanceId: id, surface: display.surface })
      })(),
      release: () => {
        if (!retirement) {
          released = true
          retirement = lease.result.then(result => api.unmount({ mountId: result.mountId }), () => {}).finally(() => {
            if (mounts.current.get(id) === lease) mounts.current.delete(id)
          })
        }
        return retirement
      },
    }
    mounts.current.set(id, lease)
    return lease
  }, [isCurrent])
  const close = useCallback((id: string, focus = true) => {
    pending.current?.instanceId === id && pending.current.decide(false)
    displaysRef.current = displaysRef.current.filter(display => display.instance.instanceId !== id)
    setDisplays(displaysRef.current)
    if (focus) {
      const opener = openers.current.get(id)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  const open = useCallback(
    (
      instance: PluginUiInstanceRecord,
      surface: PluginUiSurface,
      opener?: HTMLElement,
      forceReload = false
    ) => {
      if (
        !availableRef.current ||
        !isCurrent(instance.instanceId) ||
        instance.surface !== surface
      )
        return
      const current = displaysRef.current
      const existing = current.find(display => display.instance.instanceId === instance.instanceId)
      if (!existing && (current.length >= 2 || (surface === "session-sidebar" && current.some(display => display.surface === surface)))) return
      pending.current?.instanceId === instance.instanceId && pending.current.decide(false)
      if (opener) openers.current.set(instance.instanceId, opener)
      const next = existing
        ? current.map(display => display === existing ? { ...display, instance, key: forceReload ? crypto.randomUUID() : display.key } : display)
        : [...current, { key: crypto.randomUUID(), instance, surface }]
      displaysRef.current = next
      setDisplays(next)
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
  const conversation = usePluginUiConversation(confirm)
  useEffect(() => {
    let active = true
    displaysRef.current = []
    setDisplays([])
    pending.current?.decide(false)
    setAvailable(false)
    if (sessionId && syncStatus === "connected")
      void window.desktop?.pluginUi?.capabilities().then(caps => { if (active) setAvailable(caps.available) }).catch(() => {})
    return () => { active = false }
  }, [sessionId, syncStatus, generation])
  useEffect(() => {
    displaysRef.current = displaysRef.current.filter(display => isCurrent(display.instance.instanceId))
    setDisplays(displaysRef.current)
    if (pending.current && !isCurrent(pending.current.instanceId)) pending.current.decide(false)
  }, [view, sessionId, isCurrent])
  useEffect(() => () => {
    pending.current?.decide(false)
    openers.current.clear()
    for (const lease of mounts.current.values()) void lease.release().catch(() => {})
  }, [])
  return (
    <Context.Provider value={{ available, view, displays, isCurrent, mount, open, close, confirm, requestConversation: conversation.request,
      conversationStatus: conversation.status, queryConversation: conversation.query }}>
      {children}
      <PluginUiConfirmation details={confirmation} decide={accepted => pending.current?.decide(accepted)} />
    </Context.Provider>
  )
}
