import { describe, expect, it } from "vitest"

import { runHistoryState } from "./utils"

describe("runHistoryState", () => {
  it("opens only a run that still has its own session", () => {
    expect(runHistoryState({ status: "succeeded", sessionId: "session-1" })).toBe("openable")
    expect(runHistoryState({ status: "running" })).toBe("pending")
    expect(runHistoryState({ status: "succeeded" })).toBe("unavailable")
  })
})
