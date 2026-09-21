import type { ActivityState } from "./activity-state"

const key = "openharness.desktop.activity.v1"

type PersistedActivity = Pick<
  ActivityState,
  "lastObservedCursor" | "lastNotifiedCursor" | "readSeqBySessionId"
>

export function readActivityPersistence(): Partial<PersistedActivity> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")

    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
      return {}

    const data = value as Record<string, unknown>

    const readSeq = data["readSeqBySessionId"]

    return {
      lastObservedCursor: validSeq(data["lastObservedCursor"]),

      lastNotifiedCursor: validSeq(data["lastNotifiedCursor"]),

      readSeqBySessionId:
        readSeq && typeof readSeq === "object" && !Array.isArray(readSeq)
          ? (Object.fromEntries(
              Object.entries(readSeq).filter(
                (entry) =>
                  typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0
              )
            ) as Record<string, number>)
          : {},
    }
  } catch {
    return {}
  }
}

export function saveActivityPersistence(state: ActivityState): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        lastObservedCursor: state.lastObservedCursor,

        lastNotifiedCursor: state.lastNotifiedCursor,

        readSeqBySessionId: state.readSeqBySessionId,
      })
    )
  } catch {
    // UI read state must not interrupt the conversation when storage is unavailable.
  }
}

function validSeq(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
