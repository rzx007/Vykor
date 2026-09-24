import { mkdir, rmdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

const workspaceDirectoryName = "Vykor"
const maximumWorkspaceAttempts = 100_000

type JoinPath = (...paths: string[]) => string
type PathOperations = {
  isAbsolute: (path: string) => boolean
  join: JoinPath
  relative: (from: string, to: string) => string
  resolve: (...paths: string[]) => string
  sep: string
}

const nativePathOperations: PathOperations = { isAbsolute, join, relative, resolve, sep }

export function buildOutsideProjectRoot(documentsPath: string, joinPath: JoinPath = join): string {
  if (!documentsPath.trim()) throw new Error("系统文档目录不能为空。")
  return joinPath(documentsPath, workspaceDirectoryName)
}

/**
 * 项目外会话使用系统“文档”目录下的专用空间，不把整个用户主目录暴露为 cwd。
 * 日期按用户本地时区计算；joinPath 参数让 Windows、macOS/Linux 路径都可独立验证。
 */
export function buildOutsideProjectDayRoot(
  documentsPath: string,
  date: Date,
  joinPath: JoinPath = join
): string {
  if (Number.isNaN(date.getTime())) throw new Error("项目外工作区日期无效。")

  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return joinPath(buildOutsideProjectRoot(documentsPath, joinPath), `${year}-${month}-${day}`)
}

/** 判断已有会话/项目是否位于 Vykor 管理的项目外工作区中。 */
export function isOutsideProjectWorkspacePath(
  workspacePath: string,
  documentsPath: string,
  pathOperations: PathOperations = nativePathOperations
): boolean {
  if (!workspacePath.trim() || !documentsPath.trim()) return false

  const root = pathOperations.resolve(pathOperations.join(documentsPath, workspaceDirectoryName))
  const candidate = pathOperations.resolve(workspacePath)
  const relativePath = pathOperations.relative(root, candidate)
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${pathOperations.sep}`) &&
      relativePath !== ".." &&
      !pathOperations.isAbsolute(relativePath))
  )
}

/** 归一化工作区路径用于比较：统一分隔符、去尾斜杠、大小写不敏感。 */
export function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/**
 * 项目是否应从「项目」列表隐藏：位于项目外工作区根下，或它就是某个渠道会话的 cwd。
 * 后者不依赖路径/env，覆盖 `VYKOR_CHANNELS_DIR` 指到文档目录外的情况。
 */
export function isChannelProjectHidden(
  projectPath: string,
  channelSessionCwds: ReadonlySet<string>,
  documentsPath: string
): boolean {
  return (
    isOutsideProjectWorkspacePath(projectPath, documentsPath) ||
    channelSessionCwds.has(normalizeWorkspacePath(projectPath))
  )
}

/**
 * mkdir 本身负责抢占 xN，因此多个窗口同时创建会话也不会拿到同一目录。
 */
export async function allocateOutsideProjectWorkspace(
  documentsPath: string,
  date: Date = new Date()
): Promise<string> {
  const dayRoot = buildOutsideProjectDayRoot(documentsPath, date)
  await mkdir(dayRoot, { recursive: true })

  for (let index = 1; index <= maximumWorkspaceAttempts; index += 1) {
    const candidate = join(dayRoot, `x${index}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      throw error
    }
  }

  throw new Error(`项目外工作区数量超过上限：${dayRoot}`)
}

/** 仅清理由当前创建流程刚分配且仍为空的目录；非空目录会原样保留。 */
export async function removeEmptyOutsideProjectWorkspace(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch {
    // 会话创建失败后的尽力清理不能覆盖原始错误，也不能删除已经产生内容的目录。
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  )
}
