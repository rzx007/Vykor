import type { DeveloperDiagnosticsPage, DeveloperDomView } from "./browser-developer-inspector";

export const DEVELOPER_MAX_RESULT_BYTES = 48 * 1024

export const MAX_DOM_NODES = 150
export const MAX_DOM_DEPTH = 3
const MAX_ATTR_VALUE = 300
const MAX_TEXT_VALUE = 500
export const MAX_STYLE_PROPERTIES = 200
export const MAX_STYLE_VALUE = 300
const MAX_CONSOLE_TEXT = 300
const MAX_NETWORK_URL = 300

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export type RawDomNode = {
  nodeId?: number
  nodeType?: number
  nodeName?: string
  nodeValue?: string
  attributes?: unknown
  children?: RawDomNode[]
  [key: string]: unknown
}

const SENSITIVE_ATTRIBUTE =
  /token|secret|password|passwd|credential|api[-_]?key|cvv|cvc|nonce|integrity|authorization/i
const SENSITIVE_FIELD =
  /password|secret|token|auth|credential|card|cvv|cvc/i

export function toDomView(
  node: RawDomNode | undefined,
  budget: { nodes: number },
  depth: number
): DeveloperDomView | undefined {
  if (!node || budget.nodes <= 0) return undefined
  budget.nodes -= 1
  const nodeType = typeof node.nodeType === "number" ? node.nodeType : 0
  const rawName = typeof node.nodeName === "string" ? node.nodeName : ""
  const view: DeveloperDomView = {
    nodeType,
    name: (nodeType === 3 ? "#text" : rawName.toLowerCase()).slice(0, 80),
  }
  const attributes = Array.isArray(node.attributes) ? (node.attributes as string[]) : []
  if (attributes.length > 0) {
    const redacted = redactAttributes(view.name, attributes)
    if (Object.keys(redacted).length > 0) view.attributes = redacted
  }
  if (nodeType === 3 && typeof node.nodeValue === "string" && node.nodeValue) {
    view.text = node.nodeValue.slice(0, MAX_TEXT_VALUE)
  }
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length > 0) {
    if (depth < MAX_DOM_DEPTH) {
      const mapped: DeveloperDomView[] = []
      for (const child of children) {
        const childView = toDomView(child, budget, depth + 1)
        if (childView) mapped.push(childView)
        if (budget.nodes <= 0) break
      }
      if (mapped.length > 0) view.children = mapped
    }
    if (!view.children) view.childCount = children.length
  }
  return view
}

function redactAttributes(tagName: string, attributes: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const isField = tagName === "input" || tagName === "textarea" || tagName === "select"
  const type = readAttribute(attributes, "type")?.toLowerCase()
  const fieldMarkers = [
    readAttribute(attributes, "name"),
    readAttribute(attributes, "id"),
    readAttribute(attributes, "autocomplete"),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
  const sensitiveField =
    isField &&
    (type === "password" ||
      type === "hidden" ||
      type === "file" ||
      SENSITIVE_FIELD.test(fieldMarkers))
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index]!
    const value = attributes[index + 1] ?? ""
    if (SENSITIVE_ATTRIBUTE.test(name) || (name.toLowerCase() === "value" && sensitiveField)) {
      result[name] = "[redacted]"
    } else {
      result[name] = value.slice(0, MAX_ATTR_VALUE)
    }
  }
  return result
}

function readAttribute(attributes: string[], name: string): string | undefined {
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index]?.toLowerCase() === name) return attributes[index + 1]
  }
  return undefined
}

export function projectConsoleText(args: unknown): string {
  if (!Array.isArray(args)) return ""
  const parts: string[] = []
  for (const argument of args.slice(0, 8)) {
    if (!argument || typeof argument !== "object") continue
    const value = argument as Record<string, unknown>
    if (value.type === "string") parts.push(String(value.value ?? ""))
    else if (value.type === "number" || value.type === "boolean") parts.push(String(value.value))
    else if (value.subtype === "null") parts.push("null")
    else if (value.type === "undefined") parts.push("undefined")
    else if (typeof value.description === "string") parts.push(value.description)
    else if (typeof value.className === "string" && value.className) parts.push(value.className)
    else parts.push(`[${String(value.type ?? "value")}]`)
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_CONSOLE_TEXT)
}

/** Drops credentials, query parameters, and fragments before anything is buffered. */
export function sanitizeUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return ""
  try {
    const url = new URL(value)
    if (url.protocol === "data:") return "data:[redacted]"
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString().slice(0, MAX_NETWORK_URL)
  } catch {
    return value.split(/[?#]/)[0]!.slice(0, MAX_NETWORK_URL)
  }
}

export function capDiagnosticsPage(page: DeveloperDiagnosticsPage): DeveloperDiagnosticsPage {
  if (serializedBytes(page) <= DEVELOPER_MAX_RESULT_BYTES) return page
  page.truncated = true
  // Drop from the largest stream first, then console, until the page fits.
  while (serializedBytes(page) > DEVELOPER_MAX_RESULT_BYTES && page.network.length > 0) {
    page.network.pop()
  }
  while (serializedBytes(page) > DEVELOPER_MAX_RESULT_BYTES && page.console.length > 0) {
    page.console.pop()
  }
  return page
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}
