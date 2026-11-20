import { getDesktopDataDir, getLegacyImportFilePath } from "@vykor/host-config/paths"
import {
  confirmLegacyImport,
  digestBusinessValue,
  readLegacyImportManifest,
} from "../business-data/legacy-import"
import { createHash } from "node:crypto"
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
  let file: GitSettingsFile
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as GitSettingsFile
  } catch {
    throw new Error(`business-data git-settings read INVALID_JSON ${path}`)
  }
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
  importLegacyGitSettings(app.getPath("userData"), getDesktopDataDir(), getLegacyImportFilePath())
  return readGitSettingsAt(getDesktopDataDir())
}
export function getGitPreferences() {
  return getGitSettings().preferences
}
export function saveGitPreferences(preferences: GitPreferences, expected: GitPreferences) {
  const file = getGitSettings()
  if (JSON.stringify(file.preferences) !== JSON.stringify(expected))
    throw new Error("Git 设置已被修改，请重新读取后保存。")
  file.preferences = validateGitPreferences(preferences)
  writeGitSettingsAt(getDesktopDataDir(), file)
  return file.preferences
}
export function updateGitWorktrees(update: (records: GitWorktreeRecord[]) => GitWorktreeRecord[]) {
  const file = getGitSettings()
  file.worktrees = update(file.worktrees)
  writeGitSettingsAt(getDesktopDataDir(), file)
}

export function importLegacyGitSettings(
  legacyDirectory: string,
  directory: string,
  manifestPath: string
): void {
  const source = join(legacyDirectory, "git-settings.json")
  if (source === join(directory, "git-settings.json") || !existsSync(source)) return
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex")
  const prior = readLegacyImportManifest(manifestPath).sources["git-settings"]
  if (prior) {
    if (prior.sourceDigest !== digest)
      throw new Error(`business-data git-settings import LEGACY_CHANGED ${source}`)
    if (!existsSync(join(directory, "git-settings.json")))
      throw new Error("business-data git-settings import TARGET_MISSING")
    return
  }
  let value: GitSettingsFile
  try {
    value = readGitSettingsAt(legacyDirectory)
  } catch {
    throw new Error(`business-data git-settings import INVALID_VALUE ${source}`)
  }
  const targetDigest = digestBusinessValue(value)
  if (existsSync(join(directory, "git-settings.json"))) {
    if (digestBusinessValue(readGitSettingsAt(directory)) !== targetDigest)
      throw new Error("business-data git-settings import LEGACY_CONFLICT")
  } else writeGitSettingsAt(directory, value)
  if (digestBusinessValue(readGitSettingsAt(directory)) !== targetDigest)
    throw new Error("business-data git-settings import VERIFY_FAILED")
  confirmLegacyImport(manifestPath, "git-settings", {
    sourceDigest: digest,
    targetDigest,
    revision: 0,
  })
}
