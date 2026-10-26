import type { DesktopSessionPart } from "@shared/session-types"
import { toolOutputText } from "../models/message-content"
import { readImagePath } from "../attachments/read-image-preview"

export function readFileReference(call: DesktopSessionPart, result?: DesktopSessionPart) {
  if (call.toolName !== "Read" || readImagePath(call)) return null
  let input = call.input
  for (let depth = 0; input && depth < 8; depth++) {
    const keys = Object.keys(input)
    const key = keys[0]
    if (keys.length !== 1 || !key || !["arguments", "args", "parameters"].includes(key)) break
    const nested = input[key]
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break
    input = nested as Record<string, unknown>
  }
  const path = input?.file_path
  if (
    typeof path !== "string" ||
    !path.trim() ||
    input?.info_only === true ||
    /[\\/]$/.test(path) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(path)
  )
    return null
  const output = result?.output ?? call.output
  const summary =
    output && typeof output === "object" && "compactSummary" in output
      ? output.compactSummary
      : undefined
  const metadataSummary = result?.metadata.compactSummary ?? call.metadata.compactSummary
  if (
    [summary, metadataSummary].some(
      (value) => typeof value === "string" && /; (?:entries=|0 entries)/.test(value)
    )
  )
    return null
  const text = toolOutputText(output)
  if (text && /(?:^\(empty directory\)$|\(Showing entries \d+-\d+ of \d+\.)/m.test(text))
    return null
  const offset = input?.offset
  return {
    path,
    line:
      typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0 ? offset : undefined,
  }
}
