import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"

export type ImageLeaveGuard = (leave: () => void, blocked?: () => void) => void

/** Keep the current image mounted until its latest edit is durable. One departure at a time. */
export function useImageLeaveGuard(
  guardRef: RefObject<((keyboard?: boolean) => boolean | Promise<boolean>) | null>,
  scopeId: string,
  activeTabId: string,
  open: boolean
) {
  const context = useRef({ valid: true })
  const pending = useRef<object | null>(null)
  useLayoutEffect(() => {
    const instance = { valid: true }
    context.current = instance
    pending.current = null
    return () => {
      instance.valid = false
    }
  }, [scopeId, activeTabId, open])
  return useCallback(
    (leave: () => void, blocked?: () => void) => {
      const guard = guardRef.current
      if (!guard) {
        leave()
        return
      }
      if (pending.current) {
        blocked?.()
        return
      }
      const instance = context.current
      const request = {}
      pending.current = request
      void Promise.resolve()
        .then(() => guard())
        .then((allowed) => {
          if (!instance.valid) {
            blocked?.()
            return
          }
          if (allowed) leave()
          else blocked?.()
        })
        .catch(() => {
          blocked?.()
        })
        .finally(() => {
          if (pending.current === request) pending.current = null
        })
    },
    [guardRef]
  )
}
