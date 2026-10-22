import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser/browser-navigation"

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
  if (!/\.html?$/i.test(path) || !(windows || path.startsWith("/")) || path.startsWith("//"))
    return { openPath: rawPath.trim(), placeholderPath: null }
  const browserUrl = new URL(toLocalFileUrl("", path)).href
  const root = projectPath
    ? new URL(toLocalFileUrl("", projectPath)).href.replace(/\/+$/, "")
    : undefined
  const comparablePath = windows ? browserUrl.toLowerCase() : browserUrl
  const comparableRoot = windows ? root?.toLowerCase() : root
  const inProject =
    comparableRoot &&
    (comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`))
  if (!inProject) return { openPath: rawPath.trim(), placeholderPath: null, browserUrl }
  return { openPath: rawPath.trim(), placeholderPath: null }
}
