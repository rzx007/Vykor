import { createHash } from "node:crypto"
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js"
const HTML_MIME = "text/html;profile=mcp-app"
/** Verify official resource shapes and decoded byte totals before they cross to a frame. */
export function validateAppResource(raw: unknown, uri: string, html = false) {
  const result = ReadResourceResultSchema.parse(raw)
  if (html && (result.contents.length !== 1 || result.contents[0]?.mimeType !== HTML_MIME)) throw new Error("plugin_app_invalid_html")
  let total = 0
  const limit = (html ? 16 : 8) * 1024 * 1024
  for (const item of result.contents) {
    if (item.uri !== uri) throw new Error("plugin_app_resource_uri_mismatch")
    if ("text" in item && typeof item.text === "string") total += Buffer.byteLength(item.text)
    else if ("blob" in item && typeof item.blob === "string") {
      if (item.blob.length > Math.ceil((limit - total) / 3) * 4 || item.blob.length % 4 || /[^A-Za-z0-9+/=]/.test(item.blob)) throw new Error("plugin_app_invalid_blob")
      const decoded = Buffer.from(item.blob, "base64")
      if (decoded.toString("base64") !== item.blob) throw new Error("plugin_app_invalid_blob")
      total += decoded.byteLength
    } else throw new Error("plugin_app_invalid_resource")
    if (total > limit) throw new Error("plugin_app_resource_too_large")
  }
  return result
}
export function appHtml(raw: unknown, uri: string): { html: string; sha256: string } {
  const item = validateAppResource(raw, uri, true).contents[0]!
  if (!("text" in item) && !("blob" in item)) throw new Error("plugin_app_invalid_resource")
  const html = "text" in item ? item.text : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(item.blob, "base64"))
  return { html, sha256: createHash("sha256").update(html).digest("hex") }
}
