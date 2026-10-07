import type { DesktopNotificationMode } from "./settings-types"
import type { DesktopSessionRecord } from "./session-types"

export type DesktopNotificationEvent = "completed" | "failed" | "needs_input"
export type DesktopNotificationEvents = Record<DesktopNotificationEvent, boolean>
export const DEFAULT_NOTIFICATION_EVENTS: DesktopNotificationEvents = { completed: true, failed: true, needs_input: true }

export function normalizeNotificationEvents(value: unknown): DesktopNotificationEvents {
  const input = value && typeof value === "object" ? value as Partial<DesktopNotificationEvents> : {}
  return { completed: input.completed !== false, failed: input.failed !== false, needs_input: input.needs_input !== false }
}

export interface DesktopNotificationSystemState {
  supported: boolean
  permission: "allowed" | "blocked" | "unknown" | "unsupported"
  detail: string
  settingsAvailable: boolean
}
export interface NotificationSettingsSnapshot {
  mode: DesktopNotificationMode
  events: DesktopNotificationEvents
  system: DesktopNotificationSystemState
}
export interface NotificationTestResult {
  status: "shown" | "failed" | "unknown"
  detail: string
}
export const NotificationSettingsChannels = {
  snapshot: "notification-settings:snapshot", updateEvents: "notification-settings:update-events",
  updateMode: "notification-settings:update-mode",
  test: "notification-settings:test", openSystemSettings: "notification-settings:open-system-settings",
  resolveSession: "notification-settings:resolve-session",
} as const
export interface NotificationSettingsAPI {
  snapshot(): Promise<NotificationSettingsSnapshot>
  updateMode(input: { mode: DesktopNotificationMode; expectedMode: DesktopNotificationMode }): Promise<NotificationSettingsSnapshot>
  updateEvents(input: { events: DesktopNotificationEvents; expectedEvents: DesktopNotificationEvents }): Promise<NotificationSettingsSnapshot>
  test(): Promise<NotificationTestResult>
  openSystemSettings(): Promise<void>
  resolveSession(sessionId: string): Promise<DesktopSessionRecord | null>
}
export type NotificationSettingsIpcMap = {
  [K in keyof typeof NotificationSettingsChannels as (typeof NotificationSettingsChannels)[K]]: {
    args: Parameters<NotificationSettingsAPI[K]>; result: Awaited<ReturnType<NotificationSettingsAPI[K]>>
  }
}
