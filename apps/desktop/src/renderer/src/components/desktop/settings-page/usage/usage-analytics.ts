import type { UsageReport } from "@shared/maintenance-settings-types"

export type UsageRequest = UsageReport["requests"][number]
export type UsageMetric = "tokens" | "requests"
export type UsageWindow = { from: number; to: number }
type TokenField = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"

export const formatCount = (value: number) => value.toLocaleString("zh-CN")
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 })
export const formatTokens = (value: number | null) =>
  value === null ? "—" : value < 10_000 ? formatCount(value) : compact.format(value)
export const formatDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

export function resolveUsageWindow(
  range: string,
  from: string,
  to: string,
  now = Date.now()
): UsageWindow {
  if (range === "custom") {
    if (!from || !to) throw new Error("请选择开始和结束日期")
    const start = new Date(`${from}T00:00:00`)
    const end = new Date(`${to}T00:00:00`)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
      throw new Error("请选择有效日期")
    if (start > end) throw new Error("开始日期不能晚于结束日期")
    end.setDate(end.getDate() + 1)
    return { from: start.getTime(), to: end.getTime() }
  }
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - Number(range) + 1)
  return { from: start.getTime(), to: now }
}

function sumField(rows: readonly UsageRequest[], field: TokenField): number | null {
  if (!rows.length) return 0
  let total: number | null = null
  for (const row of rows) {
    if (row[field] !== null) total = (total ?? 0) + row[field]
  }
  return total
}

function summarize(rows: readonly UsageRequest[]) {
  const input = sumField(rows, "inputTokens")
  const output = sumField(rows, "outputTokens")
  return {
    tokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
    input,
    output,
    cacheRead: sumField(rows, "cacheReadTokens"),
    cacheCreation: sumField(rows, "cacheCreationTokens"),
    requests: rows.length,
    unknown: rows.filter((row) => row.completeness === "unknown").length,
    partial: rows.filter((row) => row.completeness === "partial").length,
  }
}

/** Bucket in the user's local calendar; cache fields are never added to input again. */
export function buildUsageAnalytics(requests: readonly UsageRequest[], window: UsageWindow) {
  const rows = requests.filter((row) => row.time >= window.from && row.time < window.to)
  const first = new Date(window.from)
  const last = new Date(window.to - 1)
  const interval =
    first.toDateString() === last.toDateString()
      ? "hour"
      : window.to - window.from > 62 * 86_400_000
        ? "month"
        : "day"
  const cursor = new Date(window.from)
  cursor.setMinutes(0, 0, 0)
  if (interval !== "hour") cursor.setHours(0)
  if (interval === "month") cursor.setDate(1)
  const bins: Array<{ time: number; end: number; label: string; rows: UsageRequest[] }> = []
  while (cursor.getTime() < window.to) {
    const time = cursor.getTime()
    const label =
      interval === "hour"
        ? `${String(cursor.getHours()).padStart(2, "0")}:00`
        : interval === "month"
          ? `${cursor.getFullYear()}/${cursor.getMonth() + 1}`
          : `${cursor.getMonth() + 1}/${cursor.getDate()}`
    if (interval === "hour") cursor.setTime(time + 3_600_000)
    else if (interval === "month") cursor.setMonth(cursor.getMonth() + 1)
    else cursor.setDate(cursor.getDate() + 1)
    bins.push({ time, end: cursor.getTime(), label, rows: [] })
  }
  // Walk sorted requests and buckets together, keeping large histories linear.
  let index = 0
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    while (index < bins.length && row.time >= bins[index].end) index++
    bins[index]?.rows.push(row)
  }
  return {
    rows,
    interval,
    totals: summarize(rows),
    buckets: bins.map(({ time, label, rows: bucket }) => ({ time, label, ...summarize(bucket) })),
  }
}

export type UsageAnalytics = ReturnType<typeof buildUsageAnalytics>
export type UsageGroup = { id: string; name: string; detail: string; value: number }

/** The top four plus the remainder always reconcile with the current metric's total. */
export function groupUsage(
  rows: readonly UsageRequest[],
  by: "model" | "provider",
  metric: UsageMetric
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()
  for (const row of rows) {
    const value = metric === "requests" ? 1 : (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
    if (value <= 0) continue
    const id = JSON.stringify(by === "model" ? [row.provider, row.model] : [row.provider])
    const name = by === "model" ? row.model : row.provider
    const group = groups.get(id) ?? {
      id,
      name: !name || name === "unknown" ? "未知" : name,
      detail: by === "model" ? (row.provider === "unknown" ? "未知供应商" : row.provider) : "",
      value: 0,
    }
    group.value += value
    groups.set(id, group)
  }
  const sorted = [...groups.values()].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
  if (sorted.length <= 4) return sorted
  return [
    ...sorted.slice(0, 4),
    {
      id: "usage-other",
      name: by === "model" ? "其他模型" : "其他供应商",
      detail: `${sorted.length - 4} 项合计`,
      value: sorted.slice(4).reduce((sum, row) => sum + row.value, 0),
    },
  ]
}
