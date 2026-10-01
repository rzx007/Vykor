import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"
import type { ProjectRecord } from "@vykor/client"
import type { DesktopProject } from "@shared/session-types"
import { requireString } from "./session-operation-input"

const execFileAsync = promisify(execFile)

export async function toDesktopProject(project: ProjectRecord): Promise<DesktopProject> {
  let available = false
  try {
    available = (await stat(project.path)).isDirectory()
  } catch {
    available = false
  }
  return { ...project, available }
}

export function parseCurrentBranch(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  const labeled = trimmed.match(/^Current branch:\s*(.+)$/i)?.[1]?.trim()
  if (labeled) return labeled
  const starred = trimmed
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("*"))
    ?.replace(/^\s*\*\s*/, "")
    .trim()
  return starred || trimmed.split(/\r?\n/)[0]?.trim() || null
}

export async function listLocalBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execGit(cwd, ["branch", "--format=%(refname:short)"])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true })
    return { stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Git operation failed: ${message}`)
  }
}

export function requireGitBranchName(value: unknown): string {
  const branch = requireString(value, "分支名称")
  if (branch.startsWith("-")) throw new Error("分支名称不能以 - 开头。")
  if (
    [...branch].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new Error("分支名称不能包含控制字符。")
  }
  return branch
}
