import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import type { SessionUserInputItem } from "@shared/session-types"

const contextStart = "\n\n<browser_annotations>\n"
const contextEnd = "\n</browser_annotations>"

export type BrowserAnnotationContextRecord = Pick<
  BrowserAnnotationRecord,
  "target" | "selector" | "comment"
> &
  Partial<Pick<BrowserAnnotationRecord, "id" | "pageUrl" | "tagName">>

export interface BrowserAnnotationContext {
  text: string
  url: string
  annotations: BrowserAnnotationContextRecord[]
}

export function formatBrowserAnnotationContext(
  records: readonly BrowserAnnotationRecord[]
): string | null {
  if (!records.length) return null
  const annotations = records.map(({ id, pageUrl, tagName, target, selector, comment }) => ({
    id,
    pageUrl,
    tagName,
    target,
    selector,
    comment,
  }))
  return (
    contextStart +
    JSON.stringify({ url: records[0]!.pageUrl, annotations }, null, 2).replaceAll("<", "\\u003c") +
    contextEnd
  )
}

function isAnnotationRecord(value: unknown): value is BrowserAnnotationContextRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    ["target", "selector", "comment"].every((key) => typeof record[key] === "string") &&
    ["id", "pageUrl", "tagName"].every(
      (key) => record[key] === undefined || typeof record[key] === "string"
    )
  )
}

export function readBrowserAnnotationContext(text: string): BrowserAnnotationContext | null {
  if (!text.endsWith(contextEnd)) return null
  const start = text.lastIndexOf(contextStart)
  if (start < 0) return null
  try {
    const data: unknown = JSON.parse(text.slice(start + contextStart.length, -contextEnd.length))
    if (
      !data ||
      typeof data !== "object" ||
      !("url" in data) ||
      typeof data.url !== "string" ||
      !("annotations" in data) ||
      !Array.isArray(data.annotations) ||
      !data.annotations.every(isAnnotationRecord)
    )
      return null
    return { text: text.slice(0, start), url: data.url, annotations: data.annotations }
  } catch {
    return null
  }
}

function trailingBrowserAnnotationContext(item: SessionUserInputItem | undefined): string | null {
  if (item?.type !== "text") return null
  const context = readBrowserAnnotationContext(item.text)
  return context ? item.text.slice(context.text.length) : null
}

export function stripBrowserAnnotationContext(
  items: readonly SessionUserInputItem[],
  sourceItems?: readonly SessionUserInputItem[]
): SessionUserInputItem[] {
  const result = [...items]
  const sourceContext = trailingBrowserAnnotationContext(sourceItems?.at(-1))
  if (sourceContext) {
    for (let index = result.length - 1; index >= 0; index--) {
      const item = result[index]!
      if (item.type !== "text") continue
      const start = item.text.lastIndexOf(sourceContext)
      if (start < 0) continue
      const text = item.text.slice(0, start) + item.text.slice(start + sourceContext.length)
      if (text) result[index] = { ...item, text }
      else result.splice(index, 1)
      return result
    }
    return result
  }
  const last = result.at(-1)
  const context = trailingBrowserAnnotationContext(last)
  if (last?.type !== "text" || !context) return result
  const text = last.text.slice(0, -context.length)
  if (text) result[result.length - 1] = { ...last, text }
  else result.pop()
  return result
}
