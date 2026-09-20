import { describe, expect, it } from "vitest"

import type { DesktopSessionRun } from "@shared/session-types"

import { selectRunNotices } from "../run-notices"

describe("selectRunNotices", () => {
  it("includes failed runs", () => {
    const run = runWith({ status: "failed" })
    expect(selectRunNotices([run])).toEqual([run])
  })

  it("includes interrupted runs flagged as stalled", () => {
    const run = runWith({ status: "interrupted", metadata: { stalled: true } })
    expect(selectRunNotices([run])).toEqual([run])
  })

  it("excludes interrupted runs without the stalled flag", () => {
    expect(selectRunNotices([runWith({ status: "interrupted" })])).toEqual([])
  })

  it("excludes completed runs", () => {
    expect(selectRunNotices([runWith({ status: "completed" })])).toEqual([])
  })
})

function runWith(overrides: Partial<DesktopSessionRun>): DesktopSessionRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "pending",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
