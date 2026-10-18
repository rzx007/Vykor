import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { usePluginUiConversation } from "./use-plugin-ui-conversation"
import {
  PluginUiDisplaysContext,
  PluginUiHostContext,
  type PluginUiDisplay,
  type PluginUiMountLease,
} from "./plugin-ui-context"
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
  view: auxiliaryView,
}: {
  children: ReactNode
  onOpenSidebar(): void
  /** An existing auxiliary session stream, owned by the current primary session. */
  view?: DesktopSessionView
}) {
  const primaryView = useDesktopSessionStore((state) => state.sessionView)
  const primarySessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const auxiliaryOwner = useRef(primarySessionId)
  const view = auxiliaryView
    ? auxiliaryOwner.current === primarySessionId && primaryView?.syncStatus === "connected"
      ? auxiliaryView
      : null
    : primaryView
  const sessionId = auxiliaryView ? (view?.session.id ?? null) : primarySessionId
  const [available, setAvailable] = useState(false)
  const [displays, setDisplays] = useState<PluginUiDisplay[]>([])
  const [confirmation, setConfirmation] = useState<PluginUiConfirmationDetails | null>(null)
  const viewRef = useRef(view)
  const scopeRef = useRef(sessionId)
  const availableRef = useRef(available)
  useLayoutEffect(() => {
    viewRef.current = view
    scopeRef.current = sessionId
    availableRef.current = available
  }, [view, sessionId, available])
  const displaysRef = useRef<PluginUiDisplay[]>([])
  // Pending loads and revocations outlive a Frame, but never retain its DOM or inputs.
  const mounts = useRef(new Map<string, PluginUiMountLease>())
  const openers = useRef(new Map<string, HTMLElement>())
  const pending = useRef<{ instanceId: string; decide(accepted: boolean): void } | null>(null)
  const generation = view?.session.metadata.pluginUiGeneration
  const syncStatus = view?.syncStatus
  const [displayScope, setDisplayScope] = useState({ sessionId, syncStatus, generation })
  if (
    displayScope.sessionId !== sessionId ||
    displayScope.syncStatus !== syncStatus ||
    !Object.is(displayScope.generation, generation)
  ) {
    setDisplayScope({ sessionId, syncStatus, generation })
    setDisplays([])
    setConfirmation(null)
    setAvailable(false)
  }
  const isCurrent = useCallback((id: string) => {
    const current = viewRef.current
    return Boolean(
      current &&
      current.session.id === scopeRef.current &&
      current.syncStatus === "connected" &&
      hasSource(current, id)
    )
  }, [])
  const mount = useCallback(
    (display: PluginUiDisplay): PluginUiMountLease => {
      const id = display.instance.instanceId
      const previous = mounts.current.get(id)
      const api = window.desktop.pluginUi
      let released = false
      let retirement: Promise<void> | undefined
      const lease: PluginUiMountLease = {
        result: (async () => {
          await previous?.release()
          if (
            released ||
            !isCurrent(id) ||
            !displaysRef.current.some((item) => item.key === display.key)
          )
            throw new PluginUiBridgeError("plugin_ui_mount_closed")
          return await api.mount({
            sessionId: display.instance.sessionId,
            instanceId: id,
            surface: display.surface,
          })
        })(),
        release: () => {
          if (!retirement) {
            released = true
            retirement = lease.result
              .then(
                (result) => api.unmount({ mountId: result.mountId }),
                () => {}
              )
              .finally(() => {
                if (mounts.current.get(id) === lease) mounts.current.delete(id)
              })
          }
          return retirement
        },
      }
      mounts.current.set(id, lease)
      return lease
    },
    [isCurrent]
  )
  const close = useCallback((id: string, focus = true) => {
    pending.current?.instanceId === id && pending.current.decide(false)
    displaysRef.current = displaysRef.current.filter(
      (display) => display.instance.instanceId !== id
    )
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
        instance.surface !== surface ||
        instance.sessionId !== viewRef.current?.session.id
      )
        return
      const current = displaysRef.current
      const existing = current.find(
        (display) => display.instance.instanceId === instance.instanceId
      )
      if (
        !existing &&
        (current.length >= 2 ||
          (surface === "session-sidebar" && current.some((display) => display.surface === surface)))
      )
        return
      pending.current?.instanceId === instance.instanceId && pending.current.decide(false)
      if (opener) openers.current.set(instance.instanceId, opener)
      const next = existing
        ? current.map((display) =>
            display === existing
              ? { ...display, instance, key: forceReload ? crypto.randomUUID() : display.key }
              : display
          )
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
  const conversation = usePluginUiConversation(confirm, view)
  useLayoutEffect(() => {
    displaysRef.current = []
    pending.current?.decide(false)
  }, [sessionId, syncStatus, generation])
  useEffect(() => {
    let active = true
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
    const current = displaysRef.current
    const next = current.filter((display) => isCurrent(display.instance.instanceId))
    if (next.length !== current.length) {
      displaysRef.current = next
      setDisplays(next)
    }
    if (pending.current && !isCurrent(pending.current.instanceId)) pending.current.decide(false)
  }, [view, sessionId, isCurrent])
  useEffect(
    () => () => {
      pending.current?.decide(false)
      openers.current.clear()
      for (const lease of mounts.current.values()) void lease.release().catch(() => {})
    },
    []
  )
  const displayControls = useMemo(() => ({ displays, close }), [displays, close])
  return (
    <PluginUiHostContext.Provider
      value={{
        available,
        view,
        displays,
        isCurrent,
        mount,
        open,
        close,
        confirm,
        requestConversation: conversation.request,
        conversationStatus: conversation.status,
        queryConversation: conversation.query,
      }}
    >
      <PluginUiDisplaysContext.Provider value={displayControls}>
        {children}
      </PluginUiDisplaysContext.Provider>
      <PluginUiConfirmation
        details={confirmation}
        decide={(accepted) => pending.current?.decide(accepted)}
      />
    </PluginUiHostContext.Provider>
  )
}
