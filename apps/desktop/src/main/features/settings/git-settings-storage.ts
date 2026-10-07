import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { defaultGitPreferences, type GitPreferences } from "../../../shared/git-settings-types"

export interface GitWorktreeRecord {
  id: string
  projectId: string
  projectPath: string
  path: string
  branch: string
  slug: string
  configDir: string
  sessionId?: string
  disposable: boolean
  baseCommit: string
  environment?: "native" | "wsl"
  distribution?: string
}
interface GitSettingsFile {
  version: 1
  preferences: GitPreferences
  worktrees: GitWorktreeRecord[]
}
export function validateGitPreferences(value: GitPreferences): GitPreferences {
  if (
    !value ||
    !["uncommitted", "staged", "unstaged"].includes(value.defaultScope) ||
    !["unified", "split"].includes(value.viewMode) ||
    typeof value.ignoreWhitespace !== "boolean" ||
    !["current", "worktree"].includes(value.defaultTaskLocation) ||
    typeof value.autoCleanup !== "boolean" ||
    typeof value.branchPrefix !== "string" ||
    value.branchPrefix.length > 100 ||
    /[\s~^:?*\[\\\x00-\x1f]/.test(value.branchPrefix) ||
    value.branchPrefix.includes("..") ||
    value.branchPrefix.startsWith("-") ||
    value.branchPrefix.startsWith("/") ||
    value.branchPrefix.includes("//") ||
    (value.worktreeRoot !== null &&
      (typeof value.worktreeRoot !== "string" || !value.worktreeRoot.trim()))
  ) {
    throw new Error("Git 偏好格式无效，请检查分支前缀和独立目录。")
  }
  return {
    defaultScope: value.defaultScope,
    viewMode: value.viewMode,
    ignoreWhitespace: value.ignoreWhitespace,
    branchPrefix: value.branchPrefix,
    defaultTaskLocation: value.defaultTaskLocation,
    worktreeRoot: value.worktreeRoot,
    autoCleanup: value.autoCleanup,
  }
}
export function readGitSettingsAt(directory: string): GitSettingsFile {
  const path = join(directory, "git-settings.json")
  if (!existsSync(path))
    return { version: 1, preferences: { ...defaultGitPreferences }, worktrees: [] }
  const file = JSON.parse(readFileSync(path, "utf8")) as GitSettingsFile
  if (file.version !== 1 || !Array.isArray(file.worktrees))
    throw new Error("不支持的 Git 设置文件版本。")
  validateGitPreferences(file.preferences)
  if (
    file.worktrees.some(
      (item) =>
        !item ||
        [
          item.id,
          item.projectId,
          item.projectPath,
          item.path,
          item.branch,
          item.slug,
          item.configDir,
          item.baseCommit,
        ].some((value) => typeof value !== "string" || !value) ||
        typeof item.disposable !== "boolean"
    )
  )
    throw new Error("Git 工作目录记录损坏。")
  return file
}
export function writeGitSettingsAt(directory: string, file: GitSettingsFile): void {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "git-settings.json")
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  renameSync(temporary, path)
}
export function getGitSettings() {
  return readGitSettingsAt(app.getPath("userData"))
}
export function getGitPreferences() {
  return getGitSettings().preferences
}
export function saveGitPreferences(preferences: GitPreferences, expected: GitPreferences) {
  const file = getGitSettings()
  if (JSON.stringify(file.preferences) !== JSON.stringify(expected))
    throw new Error("Git 设置已被修改，请重新读取后保存。")
  file.preferences = validateGitPreferences(preferences)
  writeGitSettingsAt(app.getPath("userData"), file)
  return file.preferences
}
export function updateGitWorktrees(update: (records: GitWorktreeRecord[]) => GitWorktreeRecord[]) {
  const file = getGitSettings()
  file.worktrees = update(file.worktrees)
  writeGitSettingsAt(app.getPath("userData"), file)
}
