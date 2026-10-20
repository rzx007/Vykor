import { createContext } from "react"

export function createCodeFenceActivity() {
  let count = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    getSnapshot: () => count > 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    retain() {
      if (++count === 1) notify()
      return () => {
        if (--count === 0) notify()
      }
    },
  }
}
export const CodeFenceActivityContext = createContext<ReturnType<
  typeof createCodeFenceActivity
> | null>(null)
