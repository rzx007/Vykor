import { PluginUiBridgeError, type InvokePluginUiActionInput } from "@vykor/client"
import type { DesktopPluginUiAPI } from "@shared/plugin-ui-types"

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
