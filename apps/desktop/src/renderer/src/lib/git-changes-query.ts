import type {
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitDiffScope,
} from "@shared/git-types"

const defaultMaxAgeMs = 1_000

/**
 * 缓存条数上限。每条缓存都是一份完整的 git 变更结果（含 diff 正文），所以必须封顶：
 * `maxAgeMs` 只用来判断「够不够新」，不会淘汰条目，反复切换项目或 diff scope
 * 会让这个模块级 Map 一直增长。
 */
const maxCachedQueries = 20

type CacheEntry = {
  inFlight?: Promise<DesktopGitChangesResult>
  result?: DesktopGitChangesResult
  completedAt?: number
}

const entries = new Map<string, CacheEntry>()

/** 写入缓存并维持 LRU 顺序，超出上限时淘汰最久未使用的条目。 */
function rememberQuery(key: string, entry: CacheEntry): void {
  // 先删后插：让该 key 变成 Map 中「最近使用」的一项。
  entries.delete(key)
  entries.set(key, entry)
  while (entries.size > maxCachedQueries) {
    // 正在飞行的请求要保留，否则同一 key 的并发调用会失去去重。
    const evictable = [...entries.keys()].find((candidate) => !entries.get(candidate)?.inFlight)
    if (evictable === undefined) break
    entries.delete(evictable)
  }
}

export type GitChangesQueryOptions = {
  force?: boolean
  maxAgeMs?: number
}

function normalizedScope(scope: DesktopGitDiffScope | undefined): DesktopGitDiffScope {
  return scope ?? "uncommitted"
}

export function normalizedRootPath(rootPath: string): string {
  const isWindowsPath = /^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith("\\\\")
  const normalized = (isWindowsPath ? rootPath.replace(/\\/g, "/") : rootPath).replace(/\/+$/, "")
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function queryKey(input: DesktopGitChangesInput): string {
  return `${normalizedRootPath(input.rootPath)}\u0000${normalizedScope(input.scope)}\u0000${input.ignoreWhitespace === true}`
}

export function queryGitChanges(
  input: DesktopGitChangesInput,
  options: GitChangesQueryOptions = {}
): Promise<DesktopGitChangesResult> {
  const key = queryKey(input)
  const current = entries.get(key)
  if (current?.inFlight) return current.inFlight

  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs
  if (
    !options.force &&
    current?.result &&
    current.completedAt !== undefined &&
    Date.now() - current.completedAt < maxAgeMs
  ) {
    return Promise.resolve(current.result)
  }

  const request = window.desktop.git.changes({
    ...input,
    scope: normalizedScope(input.scope),
  })
  const inFlight = request.then(
    (result) => {
      rememberQuery(key, { result, completedAt: Date.now() })
      return result
    },
    (error: unknown) => {
      entries.delete(key)
      throw error
    }
  )
  rememberQuery(key, { ...current, inFlight })
  return inFlight
}

export function resetGitChangesQueryCacheForTests(): void {
  entries.clear()
}
