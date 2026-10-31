import { IpcChannels, type TrayNotificationOptions } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { flashTray, sendTrayNotification, stopFlashTray } from "./tray"
import { notificationNavigationReady } from "./notification-navigation"

export const trayIpcContribution: IpcContribution = {
  id: "tray",
  register(ctx) {
    return [
      {
        channel: IpcChannels.trayFlash,
        handler: () => flashTray(),
      },
      {
        channel: IpcChannels.trayStopFlash,
        handler: () => stopFlashTray(),
      },
      {
        channel: IpcChannels.trayNotificationReady,
        handler: (event) => notificationNavigationReady(event.sender),
      },
      {
        channel: IpcChannels.trayNotify,
        handler: (_event, options) =>
          sendTrayNotification(
            options as TrayNotificationOptions,
            () => ctx.windowManager.getMain(),
            () => ctx.windowManager.getNotificationFocusWindow()
          ),
      },
    ]
  },
}
