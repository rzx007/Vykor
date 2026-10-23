import { describe, expect, it } from "vitest"
import type { UsageReport } from "@shared/maintenance-settings-types"
import { buildUsageAnalytics, groupUsage, resolveUsageWindow } from "../usage-analytics"

type Request = UsageReport["requests"][number]
const start = new Date(2026, 9, 21).getTime()
const end = new Date(2026, 9, 24).getTime()
function request(patch: Partial<Request> = {}): Request {
  return {
    id: "one",
    time: start,
    project: "project",
    sessionId: "session",
    runId: "run",
    provider: "provider",
    model: "model",
    status: "completed",
    completeness: "complete",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheCreationTokens: null,
    cost: null,
    ...patch,
  }
}

describe("usage analytics", () => {
  it("keeps unknown fields separate from measured zero and does not add cache twice", () => {
    const result = buildUsageAnalytics(
      [
        request(),
        request({
          id: "two",
          time: start + 1000,
          inputTokens: null,
          outputTokens: 0,
          completeness: "partial",
        }),
        request({
          id: "three",
          time: new Date(2026, 9, 22).getTime(),
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          completeness: "unknown",
        }),
      ],
      { from: start, to: end }
    )
    expect(result.totals).toMatchObject({
      tokens: 120,
      input: 100,
      output: 20,
      cacheRead: 160,
      cacheCreation: null,
      requests: 3,
      unknown: 1,
      partial: 1,
    })
    expect(result.buckets.map(({ tokens, requests }) => ({ tokens, requests }))).toEqual([
      { tokens: 120, requests: 2 },
      { tokens: null, requests: 1 },
      { tokens: 0, requests: 0 },
    ])
  })

  it("uses local calendar boundaries and excludes the upper bound", () => {
    const result = buildUsageAnalytics(
      [request({ time: start - 1 }), request({ time: start }), request({ time: end })],
      { from: start, to: end }
    )
    expect(result.totals.requests).toBe(1)
    expect(result.buckets).toHaveLength(3)
    expect(result.buckets[0].time).toBe(start)
  })

  it("uses hourly buckets for today without fabricating future hours", () => {
    const now = new Date(2026, 9, 23, 14, 22).getTime()
    const window = resolveUsageWindow("1", "", "", now)
    expect(window.from).toBe(new Date(2026, 9, 23).getTime())
    const result = buildUsageAnalytics([], window)
    expect(result.interval).toBe("hour")
    expect(result.buckets).toHaveLength(15)
    expect(result.buckets.at(-1)?.label).toBe("14:00")
  })

  it("includes the full custom end day and rejects an inverted or missing range", () => {
    expect(resolveUsageWindow("custom", "2026-10-21", "2026-10-23", end)).toEqual({
      from: start,
      to: end,
    })
    expect(() => resolveUsageWindow("custom", "2026-10-23", "2026-10-21", end)).toThrow(
      "开始日期不能晚于结束日期"
    )
    expect(() => resolveUsageWindow("custom", "", "2026-10-23", end)).toThrow(
      "请选择开始和结束日期"
    )
  })

  it("groups long custom ranges by month instead of drawing hundreds of daily bars", () => {
    const result = buildUsageAnalytics([], {
      from: new Date(2025, 0, 1).getTime(),
      to: new Date(2026, 0, 1).getTime(),
    })
    expect(result.interval).toBe("month")
    expect(result.buckets).toHaveLength(12)
  })

  it("keeps provider/model identities apart and reconciles the other group with the total", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      request({
        id: String(index),
        provider: `p${index}`,
        inputTokens: index * 10,
        outputTokens: 1,
      })
    )
    const groups = groupUsage(rows, "model", "tokens")
    expect(groups).toHaveLength(5)
    expect(groups[0]).toMatchObject({ name: "model", detail: "p6", value: 61 })
    expect(groups.at(-1)).toMatchObject({ name: "其他模型", value: 33 })
    expect(groups.reduce((sum, row) => sum + row.value, 0)).toBe(217)
    expect(groupUsage(rows, "provider", "requests").reduce((sum, row) => sum + row.value, 0)).toBe(
      7
    )
  })

  it("shows no token share for unknown-only usage but still counts the request records", () => {
    const rows = [request({ inputTokens: null, outputTokens: null, completeness: "unknown" })]
    expect(buildUsageAnalytics(rows, { from: start, to: end }).totals.tokens).toBeNull()
    expect(groupUsage(rows, "model", "tokens")).toEqual([])
    expect(groupUsage(rows, "model", "requests")[0].value).toBe(1)
  })

  it("uses the top four plus other even for exactly five groups, with unique ids", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      request({
        id: String(index),
        provider: index ? `p${index}` : "usage-other",
        inputTokens: 500 - index * 100,
      })
    )
    const groups = groupUsage(rows, "provider", "tokens")
    expect(groups).toHaveLength(5)
    expect(groups.at(-1)?.name).toBe("其他供应商")
    expect(new Set(groups.map((group) => group.id)).size).toBe(5)
  })
})
