import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"

import type {
  DesktopGitChangedFile,
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitDiffScope,
  DesktopGitFileDiffInput,
  DesktopGitFileDiffResult,
  DesktopGitFileStatus,
  DesktopGitIsRepositoryInput,
  DesktopGitIsRepositoryResult,
} from "../../../shared/git-types"

const execAsync = promisify(execFile)
const maxPatchBuffer = 8 * 1024 * 1024
const maxUntrackedStatBytes = 1_250_000
const textDecoder = new TextDecoder("utf-8", { fatal: false })

class GitService {
  async isRepository(input: DesktopGitIsRepositoryInput): Promise<DesktopGitIsRepositoryResult> {
    try {
      const path = await resolveDirectory(input.path)
      const stdout = await runGit(path, ["rev-parse", "--show-toplevel"])
      const rootPath = stdout.trim()
      return rootPath ? { isRepository: true, rootPath } : { isRepository: false, rootPath: null }
    } catch {
      return { isRepository: false, rootPath: null }
    }
  }

  async changes(input: DesktopGitChangesInput): Promise<DesktopGitChangesResult> {
    const rootPath = await resolveDirectory(input.rootPath)
    const scope = normalizeDiffScope(input.scope)
    const diffArgs = diffArgsForScope(scope)
    const [numstatOutput, nameStatusOutput, untrackedOutput] = await Promise.all([
      runGit(rootPath, ["diff", "--numstat", ...diffArgs, "--", "."]),
      runGit(rootPath, ["diff", "--name-status", ...diffArgs, "--", "."]),
      scope === "staged"
        ? Promise.resolve("")
        : runGit(rootPath, ["ls-files", "--others", "--exclude-standard"]),
    ])

    const statsByPath = parseNumstat(numstatOutput)
    const trackedFiles = parseNameStatus(nameStatusOutput).map((entry) => {
      const stats = statsByPath.get(entry.path)
      return {
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        status: entry.status,
        additions: stats?.additions ?? null,
        deletions: stats?.deletions ?? null,
        binary: stats?.binary ?? false,
      } satisfies DesktopGitChangedFile
    })

    const trackedPaths = new Set(trackedFiles.map((file) => file.path))
    const untrackedFiles = await Promise.all(
      untrackedOutput
        .split(/\r?\n/)
        .map((line) => normalizeGitPath(line.trim()))
        .filter((path) => path && !trackedPaths.has(path))
        .map((path) => toUntrackedFile(rootPath, path))
    )

    const files = [...trackedFiles, ...untrackedFiles].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    const totalAdditions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
    const totalDeletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)

    return { rootPath, files, totalAdditions, totalDeletions }
  }

  async fileDiff(input: DesktopGitFileDiffInput): Promise<DesktopGitFileDiffResult> {
    const rootPath = await resolveDirectory(input.rootPath)
    const path = normalizeRequestedPath(input.path)
    const scope = normalizeDiffScope(input.scope)
    try {
      if (
        scope !== "staged" &&
        (input.status === "untracked" || !(await isTrackedFile(rootPath, path)))
      ) {
        return await untrackedFileDiff(rootPath, path)
      }

      const patch = await runGit(
        rootPath,
        ["diff", ...diffArgsForScope(scope), "--", path],
        maxPatchBuffer
      )
      return {
        path,
        patch: patch || "(no diff)",
        binary: isBinaryPatch(patch),
      }
    } catch (error) {
      throw new Error(`无法读取文件 diff: ${errorMessage(error)}`)
    }
  }
}

function normalizeDiffScope(value: unknown): DesktopGitDiffScope {
  return value === "unstaged" || value === "staged" ? value : "uncommitted"
}

function diffArgsForScope(scope: DesktopGitDiffScope): string[] {
  if (scope === "staged") return ["--cached", "HEAD"]
  if (scope === "unstaged") return []
  return ["HEAD"]
}

async function isTrackedFile(rootPath: string, path: string): Promise<boolean> {
  try {
    await runGit(rootPath, ["ls-files", "--error-unmatch", "--", path])
    return true
  } catch {
    return false
  }
}

async function untrackedFileDiff(
  rootPath: string,
  path: string
): Promise<DesktopGitFileDiffResult> {
  const absolutePath = resolve(rootPath, path)
  const info = await stat(absolutePath)
  if (!info.isFile()) throw new Error("文件不存在或不是普通文件。")

  if (info.size > maxUntrackedStatBytes) {
    return {
      path,
      patch: "(binary)",
      binary: true,
    }
  }

  const buffer = await readFile(absolutePath)
  const binary = buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0)
  if (binary) {
    return {
      path,
      patch: "(binary)",
      binary: true,
    }
  }

  return {
    path,
    patch: createNewFilePatch(path, textDecoder.decode(buffer), info.mode),
    binary: false,
  }
}

async function resolveDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("项目路径不能为空。")
  const path = resolve(value)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error("项目路径不是目录。")
  return path
}

function normalizeRequestedPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("文件路径不能为空。")
  const normalized = normalizeGitPath(value.trim())
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    isAbsolute(normalized)
  ) {
    throw new Error("文件必须位于当前项目目录内。")
  }
  return normalized
}

async function runGit(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execAsync("git", args, {
      cwd,
      maxBuffer,
      windowsHide: true,
    })
    return stdout
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

function parseNumstat(
  output: string
): Map<string, Pick<DesktopGitChangedFile, "additions" | "deletions" | "binary">> {
  const stats = new Map<string, Pick<DesktopGitChangedFile, "additions" | "deletions" | "binary">>()

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [additionsText, deletionsText, ...pathParts] = line.split("\t")
    const rawPath = pathParts.join("\t")
    const path = normalizeGitPath(parseRenamePath(rawPath))
    if (!path) continue
    const binary = additionsText === "-" || deletionsText === "-"
    stats.set(path, {
      additions: binary ? null : parseCount(additionsText),
      deletions: binary ? null : parseCount(deletionsText),
      binary,
    })
  }

  return stats
}

function parseNameStatus(
  output: string
): Array<{ path: string; oldPath?: string; status: DesktopGitFileStatus }> {
  const files: Array<{ path: string; oldPath?: string; status: DesktopGitFileStatus }> = []

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [statusText, firstPath, secondPath] = line.split("\t")
    if (!statusText || !firstPath) continue
    const status = toFileStatus(statusText)
    const path = normalizeGitPath(secondPath ?? firstPath)
    const oldPath = secondPath ? normalizeGitPath(firstPath) : undefined
    if (!path) continue
    files.push({ path, ...(oldPath ? { oldPath } : {}), status })
  }

  return files
}

function toFileStatus(statusText: string): DesktopGitFileStatus {
  const code = statusText[0]
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "R") return "renamed"
  if (code === "C") return "copied"
  return "modified"
}

function parseCount(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRenamePath(value: string): string {
  const braceExpanded = value.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2")
  const plainRenameMatch = braceExpanded.match(/^.* => (.*)$/)
  return plainRenameMatch?.[1] ?? braceExpanded
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^"|"$/g, "")
}

function isBinaryPatch(patch: string): boolean {
  return /^Binary files /m.test(patch) || /^GIT binary patch$/m.test(patch)
}

async function toUntrackedFile(rootPath: string, path: string): Promise<DesktopGitChangedFile> {
  const absolutePath = resolve(rootPath, path)
  const info = await stat(absolutePath).catch(() => null)
  if (!info?.isFile() || info.size > maxUntrackedStatBytes) {
    return {
      path,
      status: "untracked",
      additions: null,
      deletions: null,
      binary: false,
    }
  }

  const buffer = await readFile(absolutePath)
  const binary = buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0)
  if (binary) {
    return {
      path,
      status: "untracked",
      additions: null,
      deletions: null,
      binary: true,
    }
  }

  return {
    path,
    status: "untracked",
    additions: countLines(textDecoder.decode(buffer)),
    deletions: 0,
    binary: false,
  }
}

function countLines(value: string): number {
  if (!value) return 0
  return value.endsWith("\n") ? value.split(/\r?\n/).length - 1 : value.split(/\r?\n/).length
}

function createNewFilePatch(path: string, content: string, mode: number): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const fileMode = mode & 0o111 ? "100755" : "100644"
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
  const lines = body ? body.split("\n") : []
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode ${fileMode}`,
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
  ]

  if (lines.length === 0) return `${header.join("\n")}\n`

  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]
  if (!normalized.endsWith("\n")) hunk.push("\\ No newline at end of file")
  return `${[...header, ...hunk].join("\n")}\n`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const gitService = new GitService()
