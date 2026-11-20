import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser/browser-navigation"
import { isWebDocumentPath } from "@renderer/components/desktop/tools/files/file-viewer-model"

export function prepareFileOpenRequest(
  rawPath: string,
  projectPath: string | undefined
): { openPath: string; placeholderPath: string | null; browserUrl?: string } {
  const path = rawPath
    .trim()
    .replace(/:(\d+)(?::\d+)?$/, "")
    .replace(/\\/g, "/")
    .replace(/^\/(?=[a-z]:\/)/i, "")
  const windows = /^[a-z]:\//i.test(path)
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
