import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  PluginUiBridgeError,
  parsePluginUiBridgeSnapshot,
  type InvokePluginUiActionInput,
  type JsonValue,
  type PluginUiViewSnapshot,
} from "@vykor/client"
import type {
  DesktopPluginUiAPI,
  DesktopPluginUiMountResult,
  PluginUiHostState,
} from "@shared/plugin-ui-types"
import { Button } from "@renderer/components/ui/button"
import { createPluginUiBridge } from "./plugin-ui-bridge"
import { usePluginUiHost, type PluginUiDisplay } from "./plugin-ui-provider"

export function pluginUiError(error: unknown): PluginUiBridgeError {
  const code =
    error instanceof Error ? error.message.match(/\bplugin_ui_[a-z_]+\b/)?.[0] : undefined
  return error instanceof PluginUiBridgeError
    ? error
    : new PluginUiBridgeError(code ?? "plugin_ui_unavailable")
}
export async function submitPluginUiAction(
  api: DesktopPluginUiAPI,
  mountId: string,
  input: InvokePluginUiActionInput
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      api.invokeAction({ mountId, input }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PluginUiBridgeError("plugin_ui_timeout")), 30_000)
      }),
    ])
  } catch (error) {
    if (pluginUiError(error).code !== "plugin_ui_timeout") throw pluginUiError(error)
    // Look up this exact admission; never create a second action after an uncertain response.
    return await api.getAction({ mountId, requestId: input.requestId })
  } finally {
    clearTimeout(timer)
  }
}
function hostSnapshot(state: PluginUiHostState, display: PluginUiDisplay): PluginUiViewSnapshot {
  return parsePluginUiBridgeSnapshot({
    ...state.snapshot,
    surface: display.surface,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    locale: document.documentElement.lang || navigator.language,
  })
}
export function PluginUiFrame({ display }: { display: PluginUiDisplay }) {
  const host = usePluginUiHost()!
  const hostRef = useRef(host)
  hostRef.current = host
  const iframe = useRef<HTMLIFrameElement>(null)
  const [mounted, setMounted] = useState<DesktopPluginUiMountResult | null>(null)
  const [error, setError] = useState(false)
  const [height, setHeight] = useState(320)
  const state = useRef<PluginUiHostState | null>(null)
  const bridge = useRef<ReturnType<typeof createPluginUiBridge> | null>(null)
  const live = useRef(false)
  const sequence = useRef(0)
  const target = { sessionId: display.instance.sessionId, instanceId: display.instance.instanceId }
  useEffect(() => {
    let active = true
    live.current = true
    const api = window.desktop.pluginUi
    void Promise.resolve()
      .then(async () => {
        // Effect replay can retire this setup before it starts a document load.
        if (!active) return
        const result = await api.mount({ ...target, surface: display.surface })
        if (!active || !hostRef.current.isCurrent(target.instanceId)) {
          void api.unmount({ mountId: result.mountId })
          return
        }
        if (result.url !== "vykor-plugin-ui://frame/" + result.mountId)
          throw new PluginUiBridgeError("plugin_ui_invalid_document")
        state.current = result.state
        setMounted(result)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
      live.current = false
      sequence.current++
      bridge.current?.dispose()
    }
  }, [display.key])
  useEffect(() => {
    if (error && mounted) {
      live.current = false
      bridge.current?.dispose()
      void window.desktop.pluginUi.unmount({ mountId: mounted.mountId })
    }
  }, [error, mounted])
  useLayoutEffect(() => {
    if (!mounted || !iframe.current) return
    const api = window.desktop.pluginUi
    const active = () => live.current && hostRef.current.isCurrent(target.instanceId)
    const current = () => {
      if (!active() || !state.current) throw new PluginUiBridgeError("plugin_ui_mount_closed")
      const view = hostRef.current.view
      const snapshot = hostSnapshot(state.current, display)
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
      onError: () => {
        setError(true)
        void api.unmount({ mountId: mounted.mountId })
      },
      handlers: {
        getSnapshot: async () => current(),
        resize: async (params) => {
          setHeight(params.height as number)
          return null
        },
        openSidebar: async () => {
          if (!state.current?.surfaces.includes("session-sidebar"))
            throw new PluginUiBridgeError("plugin_ui_surface_not_supported")
          hostRef.current.open(display.instance, "session-sidebar")
          return null
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
              instance: display.instance,
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
            { instance: display.instance, label: "取消此次交互", args: {}, dismiss: true },
            signal
          )
          if (!active() || signal.aborted) throw new PluginUiBridgeError("plugin_ui_mount_closed")
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
      attributeFilter: ["class", "lang"],
    })
    return () => {
      observer.disconnect()
      off()
      ready.dispose()
      bridge.current = null
      void api.unmount({ mountId: mounted.mountId })
    }
  }, [mounted, display.key])
  useEffect(() => {
    if (!mounted || !host.available || !host.isCurrent(target.instanceId)) return
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
        const updated = hostSnapshot(next, display)
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
  }, [mounted, host.view?.cursor, host.available, display.key])
  if (error)
    return (
      <div role="status" className="space-y-2 p-3 text-sm">
        <p>交互页面未能加载，原始结果仍然保留。</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => host.open(display.instance, display.surface, undefined, true)}
        >
          重新加载
        </Button>
        <a href="#/plugins" className="text-muted-foreground underline underline-offset-4">
          查看插件状态
        </a>
      </div>
    )
  if (!mounted)
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        正在加载交互页面…
      </p>
    )
  return (
    <iframe
      ref={iframe}
      src={mounted.url}
      title={mounted.state.title}
      sandbox="allow-scripts"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height: display.surface === "session-sidebar" ? "100%" : height, minHeight: 160 }}
    />
  )
}
