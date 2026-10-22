import { copyPluginAppJson, PLUGIN_APP_INPUT_LIMITS } from "@vykor/client"
/** Only text is supported. Do not silently drop images/resources or reinterpret role. */
export function pluginAppText(content: unknown, required = true): string {
  if (content === undefined && !required) return ""
  content = copyPluginAppJson(content, PLUGIN_APP_INPUT_LIMITS.messageCharacters * 8)
  if (!Array.isArray(content)) throw new Error("plugin_app_unsupported_content")
  const texts = content.map(block => {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string"
      || Object.keys(block).some(key => key !== "type" && key !== "text")) throw new Error("plugin_app_unsupported_content")
    return block.text as string
  })
  const text = texts.join("\n")
  if ([...text].length > PLUGIN_APP_INPUT_LIMITS.messageCharacters || (required && !text.trim())) throw new Error("plugin_app_invalid_message")
  return text
}
export function pluginAppContextData(value: unknown) {
  if (value === undefined) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin_app_invalid_context")
  return copyPluginAppJson(value, PLUGIN_APP_INPUT_LIMITS.handoffBytes)
}
