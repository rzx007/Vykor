const persistedActiveSessionKey = "vykor.desktop.active-session.v1"

export function readPersistedActiveSessionId(): string | null {
  try {
    const value = localStorage.getItem(persistedActiveSessionKey)?.trim()
    return value || null
  } catch {
    return null
  }
}

export function writePersistedActiveSessionId(sessionId: string): void {
  try {
    localStorage.setItem(persistedActiveSessionKey, sessionId)
  } catch {
    // Session restore is a convenience feature; storage failures must not interrupt chat use.
  }
}

export function clearPersistedActiveSessionId(): void {
  try {
    localStorage.removeItem(persistedActiveSessionKey)
  } catch {
    // Session restore is a convenience feature; storage failures must not interrupt chat use.
  }
}
