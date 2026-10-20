import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

export interface ReviewNamespace {
  scopeId: string
  rootPath: string
  range: string
  ignoreWhitespace: boolean
}
interface ReviewedFilesState {
  marks: Record<string, string>
  decisions: Record<string, number>
  setReviewed(key: string, fingerprint: string, reviewed: boolean): void
  observe(key: string, fingerprint: string, expectedDecision?: number): void
}
let decisionSequence = 0
export function reviewFileKey(source: ReviewNamespace, path: string): string {
  return JSON.stringify([
    source.scopeId,
    source.rootPath,
    source.range,
    source.ignoreWhitespace,
    path,
  ])
}
export async function reviewPatchFingerprint(patch: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(patch))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const storage = createJSONStorage(() => ({
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 审阅记录不可用时继续在内存中工作。 */
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* 同上。 */
    }
  },
}))
export const useReviewedFiles = create<ReviewedFilesState>()(
  persist(
    (set) => ({
      marks: {},
      decisions: {},
      setReviewed: (key, fingerprint, reviewed) =>
        set((state) => {
          const marks = { ...state.marks }
          const decisions = { ...state.decisions }
          delete marks[key]
          delete decisions[key]
          if (reviewed) {
            marks[key] = fingerprint
            decisions[key] = ++decisionSequence
          }
          const keys = Object.keys(marks)
          for (const expired of keys.slice(0, Math.max(0, keys.length - 512))) {
            delete marks[expired]
            delete decisions[expired]
          }
          return { marks, decisions }
        }),
      observe: (key, fingerprint, expectedDecision) =>
        set((state) => {
          const current = state.marks[key]
          if (
            !current ||
            current === fingerprint ||
            (expectedDecision !== undefined && (state.decisions[key] ?? 0) !== expectedDecision)
          )
            return state
          const marks = { ...state.marks }
          const decisions = { ...state.decisions }
          delete marks[key]
          delete decisions[key]
          return { marks, decisions }
        }),
    }),
    {
      name: "vykor.desktop.reviewed-files",
      storage,
      partialize: ({ marks }) => ({ marks }),
      merge: (saved, current) => {
        const marks: Record<string, string> = {}
        const data = (saved as { marks?: unknown } | undefined)?.marks
        if (data && typeof data === "object" && !Array.isArray(data)) {
          for (const [key, value] of Object.entries(data).slice(-512)) {
            if (key.length > 4000 || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
              continue
            try {
              const parts: unknown = JSON.parse(key)
              if (Array.isArray(parts) && parts.length === 5) marks[key] = value
            } catch {
              /* 忽略无效的本地记录。 */
            }
          }
        }
        return { ...current, marks, decisions: {} }
      },
    }
  )
)

export async function revalidateReviewedFiles(
  source: ReviewNamespace,
  paths: readonly string[],
  activePath: string | null,
  loadPatch: (path: string) => Promise<string>,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const namespace = JSON.parse(reviewFileKey(source, "")).slice(0, 4)
  const currentPaths = new Set(paths)
  const pending: Array<{ key: string; path: string; decision: number }> = []
  const snapshot = useReviewedFiles.getState()
  for (const key of Object.keys(snapshot.marks)) {
    let parts: unknown
    try {
      parts = JSON.parse(key)
    } catch {
      continue
    }
    if (!Array.isArray(parts) || JSON.stringify(parts.slice(0, 4)) !== JSON.stringify(namespace))
      continue
    const path = parts[4] as string
    const decision = snapshot.decisions[key] ?? 0
    if (!currentPaths.has(path)) useReviewedFiles.getState().observe(key, "", decision)
    else if (path !== activePath) pending.push({ key, path, decision })
  }
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length && isCurrent()) {
        const entry = pending[index++]!
        let fingerprint = ""
        try {
          fingerprint = await reviewPatchFingerprint(await loadPatch(entry.path))
        } catch {
          /* 无法验证时不继续显示已审阅。 */
        }
        if (isCurrent()) useReviewedFiles.getState().observe(entry.key, fingerprint, entry.decision)
      }
    })
  )
}
