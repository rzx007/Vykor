import { checkProtocolCompatibility, CURRENT_PROTOCOL_VERSION, supportsFeature, type ServerCapabilities } from "@openharness/client"

export function requireDesktopPluginCapabilities(capabilities: ServerCapabilities): void {
  if (
    !checkProtocolCompatibility(capabilities, { version: CURRENT_PROTOCOL_VERSION }).compatible ||
    !supportsFeature(capabilities, "pluginCapabilities", 1)
  ) {
    throw new Error("当前服务不支持完整插件能力，请同时升级 Desktop 和 daemon。")
  }
}
