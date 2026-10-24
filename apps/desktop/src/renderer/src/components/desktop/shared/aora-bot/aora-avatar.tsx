import { useEffect, useRef } from "react"

import { cn } from "@renderer/lib/utils"

export function AoraAvatar({
  name,
  size,
  className,
}: {
  name: string
  size: number
  className?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let destroy: (() => void) | undefined

    void import("./aora-runtime").then(({ mountAoraAvatar }) => {
      if (!disposed) destroy = mountAoraAvatar(container, name, size)
    })

    return () => {
      disposed = true
      destroy?.()
    }
  }, [name, size])

  return (
    <span
      ref={containerRef}
      aria-hidden="true"
      className={cn("pointer-events-none inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    />
  )
}
