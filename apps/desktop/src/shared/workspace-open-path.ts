export function toProjectRelativePath(
  path: string,
  projectPath: string | undefined
): string | null {
  const withoutLocation = path.trim().replace(/:(\d+)(?::\d+)?$/, "")
  const normalizedPath = stripExtendedPrefix(withoutLocation.replace(/\\/g, "/"))
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/$/, "")

  if (isWindowsAbsolutePath(normalizedPath)) {
    if (!normalizedProject) return null
    const projectPrefix = `${normalizedProject.toLocaleLowerCase()}/`
    if (!normalizedPath.toLocaleLowerCase().startsWith(projectPrefix)) return null
    return normalizedPath.slice(normalizedProject.length + 1)
  }

  return normalizedPath.replace(/^\.\//, "").replace(/^\//, "")
}

export function routeChangedFileClick(
  path: string,
  projectPath: string | undefined,
  canOpenReview: boolean
): "review" | "preview" {
  if (canOpenReview && isReviewablePath(path, projectPath)) return "review"
  return "preview"
}

/** Membership for deduplicating stored observations, not permissive UI routing.
 * Relative tool paths have an unknown execution cwd, so keep their original facts.
 */
export function isAbsoluteFileInRepository(path: string, repositoryRoot: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(repositoryRoot) || repositoryRoot.startsWith("\\\\") || repositoryRoot.startsWith("//")
  const root = windows ? stripExtendedPrefix(repositoryRoot.replace(/\\/g, "/")) : repositoryRoot
  const file = windows ? stripExtendedPrefix(path.replace(/\\/g, "/")) : path
  if (windows ? !isWindowsAbsolutePath(file) : !root.startsWith("/") || !file.startsWith("/") || file.startsWith("//")) return false
  try {
    // URL resolves dot segments; encode each segment so %, ? and # stay filename data.
    const normalize = (value: string): string => {
      const resolved = new URL(`file:///${value.split("/").map(encodeURIComponent).join("/")}`).pathname.replace(/\/+$/, "")
      return windows ? resolved.toLowerCase() : resolved
    }
    const resolvedRoot = normalize(root)
    const resolvedFile = normalize(file)
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}/`)
  } catch { return false }
}

function isReviewablePath(path: string, projectPath: string | undefined): boolean {
  const normalizedPath = stripExtendedPrefix(
    path.trim().replace(/:(\d+)(?::\d+)?$/, "").replace(/\\/g, "/")
  )
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/$/, "")
  if (isWindowsAbsolutePath(normalizedPath)) {
    if (!normalizedProject) return false
    return normalizedPath.toLocaleLowerCase().startsWith(`${normalizedProject.toLocaleLowerCase()}/`)
  }
  if (normalizedPath.startsWith("/") && normalizedProject?.startsWith("/")) {
    return normalizedPath === normalizedProject || normalizedPath.startsWith(`${normalizedProject}/`)
  }
  return !normalizedPath.startsWith("/") || Boolean(normalizedProject && !normalizedProject.startsWith("/"))
}

function stripExtendedPrefix(path: string): string {
  return path.replace(/^\/\/\?\//, "")
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("//")
}
