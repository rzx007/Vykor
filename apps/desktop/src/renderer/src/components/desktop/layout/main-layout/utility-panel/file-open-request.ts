import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser/browser-navigation"
import { isWebDocumentPath } from "@renderer/components/desktop/tools/files/file-viewer-model"

export function parseAttachmentDocumentPath(path: string): { assetId: string; name: string } | null {
  const match = /^attachment:\/\/([^/]+)\/(.+)$/.exec(path.trim())
  if (!match) return null
  try {
    return { assetId: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) }
  } catch {
    return null
  }
}

export function prepareFileOpenRequest(
  rawPath: string,
  projectPath: string | undefined,
  relativeBase = projectPath
): { openPath: string; placeholderPath: string | null; browserUrl?: string } {
  const path = rawPath
    .trim()
    .replace(/:(\d+)(?::\d+)?$/, "")
    .replace(/\\/g, "/")
    .replace(/^\/(?=[a-z]:\/)/i, "")
  const windows = /^[a-z]:\//i.test(path)
  const relative = !windows && !path.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(path)
  if (
    !isWebDocumentPath(path) ||
    path.startsWith("//") ||
    (!windows && /^[a-z][a-z0-9+.-]*:/i.test(path))
  )
    return {
      openPath: relative && relativeBase && relativeBase !== projectPath
        ? `${relativeBase.replace(/[\\/]+$/, "")}/${path}`
        : rawPath.trim(),
      placeholderPath: null,
    }
  if (relative && !relativeBase)
    return { openPath: rawPath.trim(), placeholderPath: null }
  // Resolve both project-relative and external paths before opening the browser.
  const url = new URL(toLocalFileUrl(relativeBase ?? "", path))
  const openPath = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, "")
  return { openPath, placeholderPath: null, browserUrl: url.href }
}
