import { normalizedRootPath } from "./git-changes-query"

const defaultMaxAgeMs = 1_000

type ProbeEntry = {
  inFlight?: Promise<boolean>
  result?: boolean
  completedAt?: number
}

const entries = new Map<string, ProbeEntry>()

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

  const request = window.desktop.git.isRepository({ path }).then(
    (response) => {
      const result = response.isRepository
      entries.set(key, { result, completedAt: Date.now() })
      return result
    },
    () => {
      entries.delete(key)
      return false
    }
  )

  entries.set(key, { ...current, inFlight: request })
  return request
}

export function resetWorkspaceGitProbeCacheForTests(): void {
  entries.clear()
}
