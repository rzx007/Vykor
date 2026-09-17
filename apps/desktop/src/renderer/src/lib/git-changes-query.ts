import type {
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitDiffScope,
} from "@shared/git-types"

const defaultMaxAgeMs = 1_000

type CacheEntry = {
  inFlight?: Promise<DesktopGitChangesResult>
  result?: DesktopGitChangesResult
  completedAt?: number
}

const entries = new Map<string, CacheEntry>()

export type GitChangesQueryOptions = {
  force?: boolean
  maxAgeMs?: number
}

function normalizedScope(scope: DesktopGitDiffScope | undefined): DesktopGitDiffScope {
  return scope ?? "uncommitted"
}

function normalizedRootPath(rootPath: string): string {
  const isWindowsPath = /^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith("\\\\")
  const normalized = (isWindowsPath ? rootPath.replace(/\\/g, "/") : rootPath).replace(/\/+$/, "")
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function queryKey(input: DesktopGitChangesInput): string {
  return `${normalizedRootPath(input.rootPath)}\u0000${normalizedScope(input.scope)}`
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
      entries.set(key, { result, completedAt: Date.now() })
      return result
    },
    (error: unknown) => {
      entries.delete(key)
      throw error
    }
  )
  entries.set(key, { ...current, inFlight })
  return inFlight
}

export function resetGitChangesQueryCacheForTests(): void {
  entries.clear()
}
