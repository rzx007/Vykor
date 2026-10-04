import { PluginUiBridgeError } from "@vykor/client";
import { IpcChannels } from "../../../shared/ipc-channels";
import type { IpcContribution } from "../../core/ipc/types";
import type { DesktopPluginUiService } from "./plugin-ui-service";
import { requireDesktopPluginUiService } from "./service-runtime";
export function createPluginUiIpcContribution(getService: () => DesktopPluginUiService = requireDesktopPluginUiService): IpcContribution {
  return { id: "plugin-ui", register: () => ([
    ["capabilities", IpcChannels.pluginUiCapabilities], ["mount", IpcChannels.pluginUiMount],
    ["getState", IpcChannels.pluginUiGetState], ["invokeAction", IpcChannels.pluginUiInvokeAction],
    ["getAction", IpcChannels.pluginUiGetAction], ["dismiss", IpcChannels.pluginUiDismiss],
    ["unmount", IpcChannels.pluginUiUnmount],
  ] as const).map(([method, channel]) => ({
    channel,
    handler: (event, value) => {
      const service = getService();
      if (!service.isOwner(event.sender.id) || event.sender.isDestroyed()
        || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
        throw new PluginUiBridgeError("plugin_ui_mount_closed");
      if (method === "capabilities") return service.capabilities(event.sender.id);
      switch (method) {
        case "mount": return service.mount(event.sender.id, value);
        case "getState": return service.getState(event.sender.id, value);
        case "invokeAction": return service.invokeAction(event.sender.id, value);
        case "getAction": return service.getAction(event.sender.id, value);
        case "dismiss": return service.dismiss(event.sender.id, value);
        case "unmount": return service.unmount(event.sender.id, value);
        default: throw new PluginUiBridgeError("plugin_ui_method_not_supported");
      }
    },
  })) };
}
export const pluginUiIpcContribution = createPluginUiIpcContribution();
