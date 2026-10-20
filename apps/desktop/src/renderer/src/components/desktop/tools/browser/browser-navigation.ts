import { toExternalBrowserUrl } from "@shared/external-browser-url"

export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^[a-z]:[\\/]/i.test(trimmed)) return windowsPathToFileUrl(trimmed)
  if (/^file:\/\//i.test(trimmed)) return new URL(trimmed).href
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^localhost(?::\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

export function resolveExternalBrowserUrl(input: string | null | undefined): string | null {
  if (input == null) return null
  const normalized = normalizeBrowserUrl(input)
  return normalized ? toExternalBrowserUrl(normalized) : null
}

export function toLocalFileUrl(projectPath: string, relativePath: string): string {
  const absolutePath = `${projectPath.replace(/[\\/]+$/, "")}\\${relativePath.replace(/^[\\/]+/, "")}`
  return windowsPathToFileUrl(absolutePath)
}

export function displayBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return parsed.href
    return parsed.host + parsed.pathname.replace(/\/$/, "") + parsed.search
  } catch {
    return url
  }
}

export function browserTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "本地文件")
    }
    return parsed.hostname || "新标签页"
  } catch {
    return "新标签页"
  }
}

function windowsPathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const match = /^([a-z]):\/(.*)$/i.exec(normalized)
  if (!match) return normalized
  const [, drive, rest] = match
  const encodedPath = rest
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `file:///${drive.toUpperCase()}:/${encodedPath}`
}
