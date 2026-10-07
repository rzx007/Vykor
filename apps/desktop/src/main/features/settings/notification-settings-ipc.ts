import { NotificationSettingsChannels, type DesktopNotificationEvents } from "../../../shared/notification-settings-types"
import type { DesktopNotificationMode } from "../../../shared/settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopNotificationSettingsService as service } from "./notification-settings-service"

export const notificationSettingsIpcContribution: IpcContribution = {
  id: "notification-settings", register() { return [
    { channel: NotificationSettingsChannels.snapshot, handler: () => service.snapshot() },
    { channel: NotificationSettingsChannels.updateEvents, handler: (_event, input) => service.updateEvents(input as { events: DesktopNotificationEvents; expectedEvents: DesktopNotificationEvents }) },
    { channel: NotificationSettingsChannels.updateMode, handler: (_event, input) => service.updateMode(input as { mode: DesktopNotificationMode; expectedMode: DesktopNotificationMode }) },
    { channel: NotificationSettingsChannels.test, handler: () => service.test() },
    { channel: NotificationSettingsChannels.openSystemSettings, handler: () => service.openSystemSettings() },
    { channel: NotificationSettingsChannels.resolveSession, handler: (_event, sessionId) => service.resolveSession(sessionId as string) },
  ] },
}
