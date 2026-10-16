import { usePluginUiHost, type PluginUiDisplay, type PluginUiMountLease } from "./plugin-ui-context"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  PluginUiBridgeError,
  parsePluginUiBridgeSnapshot,
  type InvokePluginUiActionInput,
  type JsonValue,
  type PluginUiViewSnapshot,
} from "@vykor/client"
import type { DesktopPluginUiMountResult, PluginUiHostState } from "@shared/plugin-ui-types"
import { Button } from "@renderer/components/ui/button"
import { readPluginUiAppearance } from "./plugin-ui-appearance"
import { createPluginUiBridge } from "./plugin-ui-bridge"
import { submitPluginUiAction } from "./plugin-ui-action"

function hostSnapshot(
  state: PluginUiHostState,
  display: PluginUiDisplay,
  visible: boolean
): PluginUiViewSnapshot {
  return parsePluginUiBridgeSnapshot({
    ...state.snapshot,
    surface: display.surface,
    appearance: readPluginUiAppearance(),
    capabilities: {
      draft: visible && state.conversation.draft,
      submit: visible && state.conversation.submit,
    },
    locale: document.documentElement.lang || navigator.language,
  })
}
export function PluginUiFrame({
  display,
  visible = true,
}: {
  display: PluginUiDisplay
  visible?: boolean
}) {
  // 文档身份改变时整体重置本地状态；同一文档的流式更新与隐藏不会重建 iframe。
  return <PluginUiDocument key={display.key} display={display} visible={visible} />
}
function PluginUiDocument({
  display,
  visible = true,
}: {
  display: PluginUiDisplay
  visible?: boolean
}) {
  const host = usePluginUiHost()!
  const hostRef = useRef(host)
  const visibleRef = useRef(visible)
  const displayRef = useRef(display)
  useLayoutEffect(() => {
    hostRef.current = host
    visibleRef.current = visible
    displayRef.current = display
  }, [host, visible, display])
  const iframe = useRef<HTMLIFrameElement>(null)
  const [mounted, setMounted] = useState<
    (DesktopPluginUiMountResult & { displayKey: string; lease: PluginUiMountLease }) | null
  >(null)
  const [error, setError] = useState(false)
  const [height, setHeight] = useState(320)
  const state = useRef<PluginUiHostState | null>(null)
  const bridge = useRef<ReturnType<typeof createPluginUiBridge> | null>(null)
  const live = useRef(false)
  const sequence = useRef(0)
  const sessionId = display.instance.sessionId
  const instanceId = display.instance.instanceId
  const displayKey = display.key
  const target = useMemo(() => ({ sessionId, instanceId }), [sessionId, instanceId])
  useEffect(() => {
    let active = true
    let lease: PluginUiMountLease | undefined
    const ownedDisplay = displayRef.current
    live.current = true
    void Promise.resolve()
      .then(async () => {
        // Effect replay can retire this setup before it starts a document load.
        if (!active) return
        lease = hostRef.current.mount(ownedDisplay)
        const result = await lease.result
        if (!active || !hostRef.current.isCurrent(target.instanceId)) {
          void lease.release().catch(() => {})
          return
        }
        if (result.url !== "vykor-plugin-ui://frame/" + result.mountId) {
          void lease.release().catch(() => {})
          throw new PluginUiBridgeError("plugin_ui_invalid_document")
        }
        state.current = result.state
        setMounted({ ...result, displayKey, lease })
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
      live.current = false
      bridge.current?.dispose()
      void lease?.release().catch(() => {})
    }
  }, [displayKey, target.instanceId])
  useEffect(() => {
    if (error && mounted && mounted.displayKey === display.key) {
      live.current = false
      bridge.current?.dispose()
      void mounted.lease.release().catch(() => {})
    }
  }, [error, mounted, display.key])
  useLayoutEffect(() => {
    if (!mounted || !iframe.current) return
    const api = window.desktop.pluginUi
    const active = () => live.current && hostRef.current.isCurrent(target.instanceId)
    const current = () => {
      if (!active() || !state.current) throw new PluginUiBridgeError("plugin_ui_mount_closed")
      const view = hostRef.current.view
      const snapshot = hostSnapshot(state.current, displayRef.current, visibleRef.current)
      snapshot.readOnly ||=
        view?.session.status === "archived" ||
        Boolean(view?.runs.some((run) => run.status === "running" || run.status === "pending"))
      return snapshot
    }
    const ready = createPluginUiBridge({
      iframe: iframe.current,
      mountId: mounted.mountId,
      snapshot: current(),
      isActive: active,
      isInteractive: () => visibleRef.current,
      onError: () => {
        setError(true)
        void mounted.lease.release().catch(() => {})
      },
      handlers: {
        getSnapshot: async () => current(),
        resize: async (params) => {
          setHeight(params.height as number)
          return null
        },
        requestConversation: async (params, signal, requestId) => {
          const before = current()
          if (!before.capabilities[params.mode as "draft" | "submit"])
            throw new PluginUiBridgeError("plugin_ui_conversation_unavailable")
          return await hostRef.current.requestConversation(
            mounted.mountId,
            displayRef.current.instance,
            params,
            signal,
            () => active() && visibleRef.current,
            () => ready.markAccepted(signal),
            requestId
          )
        },
        requestAction: async (params, signal) => {
          const before = current()
          if (before.readOnly) throw new PluginUiBridgeError("plugin_ui_read_only")
          const action = state.current!.actions.find((action) => action.id === params.actionId)
          if (!action) throw new PluginUiBridgeError("plugin_ui_invalid_action")
          const input: InvokePluginUiActionInput = {
            requestId: crypto.randomUUID(),
            expectedRevision: params.expectedRevision as number,
            actionId: params.actionId as string,
            args: structuredClone(params.args) as Record<string, JsonValue>,
          }
          await hostRef.current.confirm(
            {
              instance: displayRef.current.instance,
              label: action.label,
              toolName: action.toolName,
              args: input.args,
            },
            signal
          )
          if (!active() || signal.aborted) throw new PluginUiBridgeError("plugin_ui_mount_closed")
          if (current().revision !== input.expectedRevision)
            throw new PluginUiBridgeError("plugin_ui_revision_conflict")
          if (current().readOnly) throw new PluginUiBridgeError("plugin_ui_read_only")
          ready.markAccepted(signal)
          return await submitPluginUiAction(api, mounted.mountId, input)
        },
        dismiss: async (params, signal) => {
          const before = current()
          if (
            before.status !== "open" ||
            before.activeAction ||
            hostRef.current.view?.session.status === "archived"
          )
            throw new PluginUiBridgeError("plugin_ui_read_only")
          const input = {
            requestId: crypto.randomUUID(),
            expectedRevision: params.expectedRevision as number,
          }
          await hostRef.current.confirm(
            {
              instance: displayRef.current.instance,
              label: "取消此次交互",
              args: {},
              dismiss: true,
            },
            signal
          )
          if (!active() || signal.aborted) throw new PluginUiBridgeError("plugin_ui_mount_closed")
          ready.markAccepted(signal)
          await api.dismiss({ ...target, input })
          return null
        },
      },
    })
    bridge.current = ready
    const off = api.onRevoked((event) => {
      if (event.mountId === mounted.mountId) {
        ready.dispose()
        live.current = false
        hostRef.current.close(target.instanceId)
      }
    })
    const observer = new MutationObserver(() => {
      if (active()) ready.pushSnapshot(current())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "lang", "style", "data-reduced-motion"],
    })
    return () => {
      observer.disconnect()
      off()
      ready.dispose()
      bridge.current = null
      void mounted.lease.release().catch(() => {})
    }
  }, [mounted, target])
  useLayoutEffect(() => {
    bridge.current?.setVisible(visible)
    if (state.current) bridge.current?.pushSnapshot(hostSnapshot(state.current, display, visible))
  }, [visible, display])
  useEffect(() => {
    if (!mounted || !hostRef.current.available || !hostRef.current.isCurrent(target.instanceId))
      return
    const serial = ++sequence.current
    let active = true
    void window.desktop.pluginUi
      .getState(target)
      .then((next) => {
        if (
          !active ||
          !live.current ||
          serial !== sequence.current ||
          !hostRef.current.isCurrent(target.instanceId) ||
          next.snapshot.revision < (state.current?.snapshot.revision ?? 0)
        )
          return
        state.current = next
        const updated = hostSnapshot(next, displayRef.current, visibleRef.current)
        updated.readOnly ||= Boolean(
          hostRef.current.view?.runs.some(
            (run) => run.status === "pending" || run.status === "running"
          )
        )
        bridge.current?.pushSnapshot(updated)
      })
      .catch(() => {
        if (active && live.current) setError(true)
      })
    return () => {
      active = false
    }
  }, [mounted, host.view?.cursor, host.available, target])
  if (error)
    return (
      <div role="status" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>交互页面未能加载，原始结果仍然保留。</p>
        <Button
          variant="ghost"
          size="sm"
          shape="pill"
          title="重新加载后输入不保留"
          onClick={() => host.open(display.instance, display.surface, undefined, true)}
        >
          重新加载
        </Button>
        <a href="#/plugins" className="text-muted-foreground underline underline-offset-4">
          查看插件状态
        </a>
      </div>
    )
  if (!mounted || mounted.displayKey !== display.key)
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        正在加载交互页面…
      </p>
    )
  return (
    <iframe
      ref={iframe}
      hidden={!visible}
      inert={!visible}
      tabIndex={visible ? 0 : -1}
      src={mounted.url}
      title={mounted.state.title}
      sandbox="allow-scripts"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{
        display: visible ? undefined : "none",
        height: display.surface === "session-sidebar" ? "100%" : height,
        minHeight: 160,
      }}
    />
  )
}
