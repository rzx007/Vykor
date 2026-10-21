import type { DesktopPluginAppService } from "./plugin-app-service"
let service: DesktopPluginAppService | undefined
export function setDesktopPluginAppService(value: DesktopPluginAppService): void { service = value }
export function getDesktopPluginAppService(): DesktopPluginAppService | undefined { return service }
export function requireDesktopPluginAppService(): DesktopPluginAppService {
  if (!service) throw new Error("plugin_app_unavailable")
  return service
}
