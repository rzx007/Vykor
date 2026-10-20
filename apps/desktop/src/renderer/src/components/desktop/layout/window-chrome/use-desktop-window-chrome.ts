import { useCallback, useEffect, useRef, useState } from "react"

import { actualSizeZoomLevel, normalizeZoomLevel } from "@shared/zoom"

type DesktopWindowChrome = {
  isMaximized: boolean
  zoomLevel: number
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
}

function ignoreRejectedPromise(promise: Promise<unknown>): void {
  void promise.catch(() => undefined)
}

export function useDesktopWindowChrome(): DesktopWindowChrome {
  const [isMaximized, setIsMaximized] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(actualSizeZoomLevel)
  const zoomLevelRef = useRef(actualSizeZoomLevel)
  const isActiveRef = useRef(false)
  const maximizedVersionRef = useRef(0)
  const zoomVersionRef = useRef(0)

  useEffect(() => {
    let active = true
    isActiveRef.current = true
    const initialMaximizedVersion = maximizedVersionRef.current
    const initialZoomVersion = zoomVersionRef.current

    ignoreRejectedPromise(
      window.desktop.window.isMaximized().then((value) => {
        if (!active || maximizedVersionRef.current !== initialMaximizedVersion) return
        setIsMaximized(value)
      })
    )
    ignoreRejectedPromise(
      window.desktop.window.getZoomLevel().then((level) => {
        if (!active || zoomVersionRef.current !== initialZoomVersion) return
        const normalizedLevel = normalizeZoomLevel(level)
        zoomLevelRef.current = normalizedLevel
        setZoomLevel(normalizedLevel)
      })
    )
    const unsubscribe = window.desktop.window.onMaximizedChanged((value) => {
      maximizedVersionRef.current += 1
      if (active) setIsMaximized(value)
    })

    return () => {
      active = false
      isActiveRef.current = false
      unsubscribe()
    }
  }, [])

  const applyZoomLevel = useCallback((requestedLevel: number): void => {
    if (!isActiveRef.current) return

    const nextLevel = normalizeZoomLevel(requestedLevel)
    const requestVersion = zoomVersionRef.current + 1
    zoomVersionRef.current = requestVersion
    zoomLevelRef.current = nextLevel
    setZoomLevel(nextLevel)
    ignoreRejectedPromise(
      window.desktop.window.setZoomLevel(nextLevel).then((appliedLevel) => {
        if (!isActiveRef.current || zoomVersionRef.current !== requestVersion) return
        const normalizedLevel = normalizeZoomLevel(appliedLevel)
        zoomLevelRef.current = normalizedLevel
        setZoomLevel(normalizedLevel)
      })
    )
  }, [])

  const zoomIn = useCallback((): void => {
    applyZoomLevel(zoomLevelRef.current + 1)
  }, [applyZoomLevel])

  const zoomOut = useCallback((): void => {
    applyZoomLevel(zoomLevelRef.current - 1)
  }, [applyZoomLevel])

  const resetZoom = useCallback((): void => {
    applyZoomLevel(actualSizeZoomLevel)
  }, [applyZoomLevel])

  const minimize = useCallback((): void => {
    ignoreRejectedPromise(window.desktop.window.minimize())
  }, [])

  const toggleMaximize = useCallback((): void => {
    ignoreRejectedPromise(window.desktop.window.toggleMaximize())
  }, [])

  const close = useCallback((): void => {
    ignoreRejectedPromise(window.desktop.window.close())
  }, [])

  return {
    isMaximized,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetZoom,
    minimize,
    toggleMaximize,
    close,
  }
}
