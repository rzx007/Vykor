import { PluginUiBridgeError } from "@vykor/client";
import type { DesktopPluginUiService } from "./plugin-ui-service";
let current: DesktopPluginUiService | undefined;
export function setDesktopPluginUiService(service: DesktopPluginUiService): void { current = service; }
export function getDesktopPluginUiService(): DesktopPluginUiService | undefined { return current; }
export function requireDesktopPluginUiService(): DesktopPluginUiService {
  if (!current) throw new PluginUiBridgeError("plugin_ui_unavailable");
  return current;
}
