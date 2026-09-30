import { isAbsolute, relative, resolve } from "node:path"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { DeveloperScope } from "./browser-developer-inspector"

/**
 * Resolves the only scopes this feature supports: an http(s) origin, or a
 * workspace-local file resolved through symlinks. Anything else fails closed.
 */
export function resolveDeveloperScope(value: string, cwd: string): DeveloperScope | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "http", scope: url.origin, url: url.toString() }
  }
  if (url.protocol !== "file:") return null

  let target: string
  try {
    target = realpathSync(fileURLToPath(url))
  } catch {
    return null
  }
  let root: string
  try {
    root = realpathSync(resolve(cwd))
  } catch {
    root = resolve(cwd)
  }
  const relativePath = relative(root, target)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null
  return { kind: "file", scope: `file:${target}`, url: url.toString(), filePath: target }
}

/** Bounded description of one inspection category, safe to render on a card. */
export function describeDeveloperAction(action: string): string {
  switch (action) {
    case "inspect_dom":
      return "DOM structure"
    case "inspect_styles":
      return "computed styles"
    case "start_diagnostics":
      return "console and network capture"
    case "read_diagnostics":
      return "console and network results"
    case "stop_diagnostics":
      return "capture stop"
    default:
      return "developer inspection"
  }
}
