import { realpath, stat } from "node:fs/promises"
import { join, posix, sep, win32 } from "node:path"
import { resolveManagedHistoryPath } from "@vykor/host-config/paths"

export type WorkspaceFileScope = "project" | "extra-root"

export type WorkspacePathClassification = {
  kind: WorkspaceFileScope
  rootPath: string
  relativePath: string
  tabPath: string
  rootLabel: string
}

export type WorkspaceAllowedRoots = {
  projectRoot: string
  configDir: string
  skillsDir: string
  userProfilePath: string
  outsideProjectRoot: string
  managedWorkspaceRoots?: string[]
}

export type PathFlavor = {
  isAbsolute: (path: string) => boolean
  normalize: (path: string) => string
  resolve: (...paths: string[]) => string
  relative: (from: string, to: string) => string
  parse: (path: string) => { root: string }
  sep: string
}

export type WorkspacePathOps = {
  win32: PathFlavor
  posix: PathFlavor
}

export function stripLocationSuffix(path: string): string {
  return path.trim().replace(/:(\d+)(?::\d+)?$/, "")
}

export function isPathInside(candidate: string, root: string, pathApi: PathFlavor): boolean {
  const resolvedRoot = pathApi.resolve(stripExtendedPrefix(root))
  const resolvedCandidate = pathApi.resolve(stripExtendedPrefix(candidate))
  const relativePath = pathApi.relative(resolvedRoot, resolvedCandidate)
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") &&
      relativePath !== ".." &&
      !pathApi.isAbsolute(relativePath) &&
      !relativePath.includes(`..${pathApi.sep}`))
  )
}

export async function resolveWorkspaceOpenTarget(
  path: string,
  rootPath: string | undefined,
  roots: WorkspaceAllowedRoots
): Promise<{ path: string; isDirectory: boolean }> {
  if (typeof path !== "string" || !path.trim()) throw new Error("路径不能为空。")
  if (typeof rootPath !== "string" || !rootPath.trim()) throw new Error("项目路径不能为空。")
  path = await resolveManagedHistoryPath(stripLocationSuffix(path), roots.configDir)

  const classification = classifyWorkspacePath(
    path,
    { ...roots, projectRoot: rootPath },
    {
      win32,
      posix,
    }
  )
  if (!classification) throw new Error("文件必须位于当前项目目录内。")

  const candidate =
    classification.kind === "project"
      ? join(rootPath, ...classification.relativePath.split("/").filter(Boolean))
      : classification.tabPath.replace(/\//g, sep)
  let absolutePath: string
  try {
    absolutePath = await realpath(candidate)
  } catch {
    throw new Error("无法预览。")
  }

  const rootsWithProject = { ...roots, projectRoot: rootPath }
  if (
    !stillInsideAllowedRoot(absolutePath, classification, rootPath, rootsWithProject, {
      win32,
      posix,
    })
  ) {
    throw new Error("文件必须位于当前项目目录内。")
  }

  const info = await stat(absolutePath)
  return { path: absolutePath, isDirectory: info.isDirectory() }
}

export function stillInsideAllowedRoot(
  absolutePath: string,
  classification: WorkspacePathClassification,
  projectRoot: string,
  roots: WorkspaceAllowedRoots,
  pathOps: WorkspacePathOps
): boolean {
  const checkRoot =
    classification.kind === "project"
      ? projectRoot
      : classification.rootLabel === "个人配置"
        ? classification.relativePath === "USER.md"
          ? roots.userProfilePath
          : roots.skillsDir
        : classification.rootPath
  return isInsideAny(absolutePath, checkRoot, pathOps)
}

export function classifyWorkspacePath(
  rawPath: string,
  roots: WorkspaceAllowedRoots,
  pathOps: WorkspacePathOps
): WorkspacePathClassification | null {
  const cleaned = stripLocationSuffix(rawPath)
  if (!cleaned) return null

  const candidates = collectAbsoluteCandidates(cleaned, roots, pathOps)
  for (const candidate of candidates) {
    const matched = matchAllowedRoot(candidate, roots, pathOps)
    if (matched) return matched
  }

  // 绝对路径必须命中允许根，不能剥去根前缀后当作项目相对路径。
  if (candidates.length > 0) return null

  const relativePath = toForwardSlashes(cleaned).replace(/^\.\//, "")
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return null

  return {
    kind: "project",
    rootPath: roots.projectRoot,
    relativePath,
    tabPath: relativePath,
    rootLabel: "",
  }
}

function collectAbsoluteCandidates(
  path: string,
  roots: WorkspaceAllowedRoots,
  pathOps: WorkspacePathOps
): string[] {
  const candidates: string[] = []
  const withoutExtended = stripExtendedPrefix(path)
  if (looksWindowsAbsolute(withoutExtended) || looksWindowsAbsolute(path)) {
    candidates.push(pathOps.win32.resolve(withoutExtended))
  }

  const posixForm = toForwardSlashes(withoutExtended)
  if (pathOps.posix.isAbsolute(posixForm)) {
    candidates.push(pathOps.posix.normalize(posixForm))
    for (const root of extraMappingRoots(roots)) {
      if (!root) continue
      const drive = pathOps.win32.parse(root).root
      if (!isWindowsDriveRoot(drive)) continue
      candidates.push(pathOps.win32.resolve(drive, posixForm.replace(/^\//, "")))
    }
  }

  return [...new Set(candidates)]
}

function extraMappingRoots(roots: WorkspaceAllowedRoots): string[] {
  return [
    roots.projectRoot,
    roots.skillsDir,
    roots.configDir,
    roots.outsideProjectRoot,
    ...(roots.managedWorkspaceRoots ?? []),
  ]
}

function matchAllowedRoot(
  candidate: string,
  roots: WorkspaceAllowedRoots,
  pathOps: WorkspacePathOps
): WorkspacePathClassification | null {
  if (isInsideAny(candidate, roots.projectRoot, pathOps)) {
    return classification("project", roots.projectRoot, candidate, roots.projectRoot, "", pathOps)
  }

  if (isInsideAny(candidate, roots.skillsDir, pathOps)) {
    return classification(
      "extra-root",
      roots.configDir,
      candidate,
      roots.configDir,
      "个人配置",
      pathOps
    )
  }

  if (isSameFile(candidate, roots.userProfilePath, pathOps)) {
    return {
      kind: "extra-root",
      rootPath: roots.configDir,
      relativePath: "USER.md",
      tabPath: toForwardSlashes(stripExtendedPrefix(candidate)),
      rootLabel: "个人配置",
    }
  }

  for (const root of [roots.outsideProjectRoot, ...(roots.managedWorkspaceRoots ?? [])]) {
    if (root && isInsideAny(candidate, root, pathOps)) {
      return classification("extra-root", root, candidate, root, "项目外工作区", pathOps)
    }
  }

  return null
}

function classification(
  kind: WorkspaceFileScope,
  displayRoot: string,
  candidate: string,
  rootPath: string,
  rootLabel: string,
  pathOps: WorkspacePathOps
): WorkspacePathClassification {
  const relativePath = toPosixRelative(displayRoot, candidate, pathOps)
  return {
    kind,
    rootPath,
    relativePath,
    tabPath: kind === "project" ? relativePath : toForwardSlashes(stripExtendedPrefix(candidate)),
    rootLabel,
  }
}

function toPosixRelative(root: string, candidate: string, pathOps: WorkspacePathOps): string {
  const flavor =
    looksWindowsAbsolute(candidate) || looksWindowsAbsolute(root) ? pathOps.win32 : pathOps.posix
  return toForwardSlashes(flavor.relative(flavor.resolve(root), flavor.resolve(candidate)))
}

function isInsideAny(candidate: string, root: string, pathOps: WorkspacePathOps): boolean {
  if (!root || looksWindowsAbsolute(candidate) !== looksWindowsAbsolute(root)) return false
  return looksWindowsAbsolute(root)
    ? isPathInside(candidate, root, pathOps.win32)
    : isPathInside(candidate, root, pathOps.posix)
}

function isSameFile(left: string, right: string, pathOps: WorkspacePathOps): boolean {
  if (!right || looksWindowsAbsolute(left) !== looksWindowsAbsolute(right)) return false
  const flavor = looksWindowsAbsolute(right) ? pathOps.win32 : pathOps.posix
  return normalizeComparable(left, flavor) === normalizeComparable(right, flavor)
}

function normalizeComparable(path: string, pathApi: PathFlavor): string {
  const normalized = toForwardSlashes(stripExtendedPrefix(pathApi.resolve(path)))
  return looksWindowsAbsolute(normalized) ? normalized.toLocaleLowerCase() : normalized
}

function looksWindowsAbsolute(path: string): boolean {
  return isWindowsAbsolutePath(toForwardSlashes(stripExtendedPrefix(path)))
}

function isWindowsDriveRoot(root: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(root)
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("//")
}

function stripExtendedPrefix(path: string): string {
  return path.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "")
}

function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/")
}
