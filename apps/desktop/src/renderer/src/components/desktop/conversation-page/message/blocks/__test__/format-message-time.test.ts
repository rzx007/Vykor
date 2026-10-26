import { describe, expect, it } from "vitest"

import { formatMessageTime } from "../format-message-time"

describe("formatMessageTime", () => {
  const now = Date.parse("2026-08-16T15:23:00")

  it("shows only the clock on the same day", () => {
    expect(formatMessageTime(Date.parse("2026-08-16T09:05:00"), now)).toBe("09:05")
  })

  it("shows weekday and clock within the same week", () => {
    expect(formatMessageTime(Date.parse("2026-08-10T10:00:00"), now)).toBe("星期一 10:00")
    expect(formatMessageTime(Date.parse("2026-08-15T18:40:00"), now)).toBe("星期六 18:40")
  })

  it("shows month, day, and clock outside the current week", () => {
    expect(formatMessageTime(Date.parse("2026-07-23T15:23:00"), now)).toBe("07月23 15:23")
    expect(formatMessageTime(Date.parse("2026-08-09T08:01:00"), now)).toBe("08月09 08:01")
  })
})
