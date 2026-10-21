import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { ReadResourceResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { PluginAppController } from "./controller"
/** All callbacks terminate at the finite preload API; no MCP Client or executable function crosses it. */
export function installAppHandlers(bridge: AppBridge, controller: PluginAppController): void {
  const mountId = controller.mounted.mountId
  bridge.onmessage = (params, extra) => controller.sendMessage(params.role, params.content, extra.signal)
  bridge.onupdatemodelcontext = params => controller.updateModelContext(params.content, params.structuredContent)
  bridge.oncalltool = (params, extra) => controller.callTool(params.name, params.arguments ?? {}, extra.signal)
  bridge.onreadresource = async params => {
    controller.assertAvailable()
    return ReadResourceResultSchema.parse(await controller.api.readResource({ mountId, uri: params.uri }))
  }
  bridge.onlistresources = async params => {
    controller.assertAvailable()
    return ListResourcesResultSchema.parse(await controller.api.listResources({ mountId, cursor: params?.cursor }))
  }
  bridge.onlistresourcetemplates = async params => {
    controller.assertAvailable()
    return ListResourceTemplatesResultSchema.parse(await controller.api.listResourceTemplates({ mountId, cursor: params?.cursor }))
  }
}
