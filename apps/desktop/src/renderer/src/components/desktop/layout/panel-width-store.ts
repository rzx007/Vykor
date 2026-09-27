export type PanelWidthStoreConfig = {
  storageKey: string
  defaultPx: number
  minPx: number
  maxPx: number
}

export type PanelWidthStore = {
  storageKey: string
  defaultPx: number
  minPx: number
  maxPx: number
  clamp: (width: number) => number
  read: () => number | null
  persist: (width: number) => void
  resolveDefault: () => number
}

/**
 * Pixel width persistence for a resizable panel: reads/writes a single
 * localStorage key as a raw decimal string and clamps to [minPx, maxPx].
 */
export function createPanelWidthStore({
  storageKey,
  defaultPx,
  minPx,
  maxPx,
}: PanelWidthStoreConfig): PanelWidthStore {
  const clamp = (width: number): number => {
    if (!Number.isFinite(width)) return defaultPx
    return Math.round(Math.min(maxPx, Math.max(minPx, width)))
  }

  const read = (): number | null => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) return null
      return clamp(parsed)
    } catch {
      return null
    }
  }

  const persist = (width: number): void => {
    try {
      localStorage.setItem(storageKey, String(clamp(width)))
    } catch {
      // Panel width is best-effort UI state and must never interrupt the desktop app.
    }
  }

  return {
    storageKey,
    defaultPx,
    minPx,
    maxPx,
    clamp,
    read,
    persist,
    resolveDefault: () => read() ?? defaultPx,
  }
}

export function shouldPersistPanelWidth(
  meta: { isUserInteraction: boolean },
  inPixels: number
): boolean {
  return meta.isUserInteraction && Number.isFinite(inPixels) && inPixels > 1
}
