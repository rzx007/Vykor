import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser/browser-navigation"
import { isWebDocumentPath } from "@renderer/components/desktop/tools/files/file-viewer-model"

export function prepareFileOpenRequest(
  rawPath: string,
  projectPath: string | undefined,
  sessionFiles = false
): { openPath: string; placeholderPath: string | null; browserUrl?: string } {
  const path = rawPath
    .trim()
    .replace(/:(\d+)(?::\d+)?$/, "")
    .replace(/\\/g, "/")
    .replace(/^\/(?=[a-z]:\/)/i, "")
  const windows = /^[a-z]:\//i.test(path)
  if (sessionFiles) {
    const root = projectPath?.replace(/\\/g, "/").replace(/\/$/, "")
    const prefix = root && `${root}/`
    const isWithin = prefix && (windows
      ? path.toLowerCase().startsWith(prefix.toLowerCase())
      : path.startsWith(prefix))
    const openPath = prefix && isWithin ? path.slice(prefix.length) : path.replace(/^(?:\.\/)+/, "")
    return { openPath, placeholderPath: null }
  }
  if (
    !isWebDocumentPath(path) ||
    path.startsWith("//") ||
    (!windows && /^[a-z][a-z0-9+.-]*:/i.test(path))
  )
    return { openPath: rawPath.trim(), placeholderPath: null }
  if (!windows && !path.startsWith("/") && !projectPath)
    return { openPath: rawPath.trim(), placeholderPath: null }
  // Resolve both project-relative and external paths before opening the browser.
  const url = new URL(toLocalFileUrl(projectPath ?? "", path))
  const openPath = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, "")
  return { openPath, placeholderPath: null, browserUrl: url.href }
}
