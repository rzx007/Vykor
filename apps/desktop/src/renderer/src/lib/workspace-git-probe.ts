import { normalizedRootPath } from "./git-changes-query"

const defaultMaxAgeMs = 1_000
const maxEntries = 64

type ProbeEntry = {
  inFlight?: Promise<boolean>
  result?: boolean
  completedAt?: number
}

const entries = new Map<string, ProbeEntry>()

/** 写入时把最早插入的键挤出去，避免长期运行下路径只增不减。 */
function setEntry(key: string, entry: ProbeEntry): void {
  entries.delete(key)
  entries.set(key, entry)
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export async function probeWorkspaceGit(path: string): Promise<boolean> {
  if (!path.trim()) return false

  const key = normalizedRootPath(path)
  const current = entries.get(key)
  if (current?.inFlight) return current.inFlight

  if (
    current?.result !== undefined &&
    current.completedAt !== undefined &&
    Date.now() - current.completedAt < defaultMaxAgeMs
  ) {
    return current.result
  }

  let pending: Promise<{ isRepository?: boolean } | undefined>
  try {
    const bridge = window.desktop?.git
    pending = bridge ? bridge.isRepository({ path }) : Promise.resolve(undefined)
  } catch {
    entries.delete(key)
    return false
  }

  const request = pending
    .then((response) => {
      const isRepository = response?.isRepository
      if (isRepository !== true && isRepository !== false) {
        entries.delete(key)
        return false
      }
      setEntry(key, { result: isRepository, completedAt: Date.now() })
      return isRepository
    })
    .catch(() => {
      entries.delete(key)
      return false
    })

  setEntry(key, { ...current, inFlight: request })
  return request
}

export function resetWorkspaceGitProbeCacheForTests(): void {
  entries.clear()
}
