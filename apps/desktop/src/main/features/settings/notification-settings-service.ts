import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { app, Notification, shell } from "electron"
import type { DesktopSessionRecord } from "../../../shared/session-types"
import { normalizeNotificationEvents, type DesktopNotificationEvents, type DesktopNotificationSystemState, type NotificationSettingsSnapshot, type NotificationTestResult } from "../../../shared/notification-settings-types"
import { getDesktopPreferences, patchDesktopPreferences } from "./desktop-preferences"
import { desktopSessionService } from "../session/session-service"
import { isDesktopNotificationMode, type DesktopNotificationMode } from "../../../shared/settings-types"

const run = promisify(execFile)

export function readRegistryDword(output: string): number | undefined {
  const match = /REG_DWORD\s+(0x[\da-f]+|\d+)/i.exec(output)
  return match ? Number(match[1]) : undefined
}

async function windowsNotificationPermission(): Promise<"allowed" | "blocked" | "unknown"> {
  const checks = [
    ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", "ToastEnabled"],
    [`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${app.isPackaged ? "app.vykor.desktop" : "dev.vykor.desktop"}`, "Enabled"],
  ]
  const values = await Promise.all(checks.map(async ([path, name]) => {
    try { return readRegistryDword((await run("reg.exe", ["query", path, "/v", name], { windowsHide: true, timeout: 3000 })).stdout) }
    catch { return undefined }
  }))
  if (values.includes(0)) return "blocked"
  return values.every((value) => value === 1) ? "allowed" : "unknown"
}

export async function notificationSystemState(): Promise<DesktopNotificationSystemState> {
  const supported = Notification.isSupported()
  const permission = !supported ? "unsupported" : process.platform === "win32" ? await windowsNotificationPermission() : "unknown"
  return { supported, permission, settingsAvailable: process.platform === "win32" || process.platform === "darwin", detail: permission === "unsupported" ? "此系统或桌面环境不支持原生通知。" : permission === "blocked" ? "系统设置已关闭通知，请在系统通知设置中开启。" : permission === "allowed" ? "系统与应用通知开关已开启；勿扰模式仍可能抑制提醒。" : "系统支持通知，但无法直接确定应用授权或勿扰状态。请发送测试并查看系统设置。" }
}

export const desktopNotificationSettingsService = {
  async snapshot(): Promise<NotificationSettingsSnapshot> {
    const preferences = getDesktopPreferences()
    return { mode: preferences.notificationMode, events: normalizeNotificationEvents(preferences.notificationEvents), system: await notificationSystemState() }
  },
  async updateEvents(input: { events: DesktopNotificationEvents; expectedEvents: DesktopNotificationEvents }): Promise<NotificationSettingsSnapshot> {
    if (!input?.events || !input.expectedEvents || !Object.values(input.events).every((value) => typeof value === "boolean") || !["completed", "failed", "needs_input"].every((name) => typeof input.events[name as keyof DesktopNotificationEvents] === "boolean")) throw new Error("通知事件开关格式无效。")
    const current = normalizeNotificationEvents(getDesktopPreferences().notificationEvents)
    if (JSON.stringify(current) !== JSON.stringify(normalizeNotificationEvents(input.expectedEvents))) throw new Error("通知设置已被其他窗口修改，请重新读取后重试。")
    patchDesktopPreferences({ notificationEvents: normalizeNotificationEvents(input.events) })
    return this.snapshot()
  },
  async updateMode(input: { mode: DesktopNotificationMode; expectedMode: DesktopNotificationMode }): Promise<NotificationSettingsSnapshot> {
    if (!input || !isDesktopNotificationMode(input.mode)) throw new Error("通知模式无效。")
    if (getDesktopPreferences().notificationMode !== input.expectedMode) throw new Error("通知设置已被其他窗口修改，请重新读取后重试。")
    patchDesktopPreferences({ notificationMode: input.mode })
    return this.snapshot()
  },
  async test(): Promise<NotificationTestResult> {
    const system = await notificationSystemState()
    if (!system.supported || system.permission === "blocked") return { status: "failed", detail: system.detail }
    return new Promise((resolve) => {
      const notification = new Notification({ title: "Vykor 测试通知", body: "这是测试通知。任务正文、命令和机密信息不会显示在通知中。", silent: true })
      const timer = setTimeout(() => { notification.removeAllListeners(); resolve({ status: "unknown", detail: "已提交测试，但系统没有报告显示结果。请检查通知中心、应用权限和勿扰模式。" }) }, 5000)
      const finish = (result: NotificationTestResult) => { clearTimeout(timer); notification.removeAllListeners(); resolve(result) }
      notification.once("show", () => finish({ status: "shown", detail: "系统已报告测试通知显示。若未看到横幅，请检查通知中心和勿扰模式。" }))
      notification.once("failed", () => finish({ status: "failed", detail: "系统拒绝显示测试通知，请检查应用通知权限。" }))
      try { notification.show() } catch { finish({ status: "failed", detail: "无法发送测试通知，请检查系统通知支持。" }) }
    })
  },
  async openSystemSettings(): Promise<void> {
    if (process.platform === "win32") return shell.openExternal("ms-settings:notifications")
    if (process.platform === "darwin") return shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications")
    throw new Error("此桌面环境没有统一通知设置入口，请从系统设置手动打开通知设置。")
  },
  async resolveSession(sessionId: string): Promise<DesktopSessionRecord | null> {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("会话标识无效。")
    try { return await (await desktopSessionService.daemonClient()).sessions.get(sessionId) as DesktopSessionRecord }
    catch (error) {
      const value = error as { status?: number; message?: string }
      if (value.status === 404 || /session.*not found|session.*does not exist|会话.*不存在|\b404\b/i.test(value.message ?? "")) return null
      throw error
    }
  },
}
