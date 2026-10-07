import { expect, it } from "vitest"
import { diagnosisSummary } from "./diagnostics-presentation"
import { filterDiagnosticLogRecords } from "@shared/diagnostic-log-filter"

it("never reports cancelled, unsupported or empty checks as healthy", () => {
  for (const status of ["cancelled", "unsupported", "timeout"] as const) {
    const summary = diagnosisSummary([{ id: "health", name: "后台服务", status, detail: "" }])
    expect(summary.passed).toBe(0)
    expect(summary.incomplete).toBe(1)
    expect(summary.tone).not.toBe("success")
  }
  expect(diagnosisSummary([]).tone).toBe("neutral")
})
it("keeps failures, warnings and incomplete coverage distinct", () => {
  expect(
    diagnosisSummary([
      { id: "a", name: "A", status: "success", detail: "" },
      { id: "b", name: "B", status: "failed", detail: "" },
      { id: "c", name: "C", status: "warning", detail: "" },
      { id: "d", name: "D", status: "cancelled", detail: "" },
    ])
  ).toMatchObject({ passed: 1, failed: 1, warnings: 1, incomplete: 1, tone: "error" })
})
it("searches only loaded logs and supports a combined problem-level filter", () => {
  const logs = [
    { time: 1, level: "info", module: "session", event: "session.started" },
    { time: 2, level: "error", module: "session", event: "session.failed", runId: "run-1" },
    { time: 3, level: "warn", module: "mcp", event: "mcp.disconnected" },
  ]
  expect(filterDiagnosticLogRecords(logs, { level: "problems" })).toEqual([logs[1], logs[2]])
  expect(filterDiagnosticLogRecords(logs, { level: "all", query: "run-1" })).toEqual([logs[1]])
  expect(filterDiagnosticLogRecords(logs, { level: "all", query: "not-recorded" })).toEqual([])
})
