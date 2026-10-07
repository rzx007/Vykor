import type { DiagnosticFilter, DiagnosticLog } from "./maintenance-settings-types"

/** 页面和导出使用同一筛选条件，仅搜索已读取的脱敏字段。 */
export function filterDiagnosticLogRecords(logs: DiagnosticLog[], filter: DiagnosticFilter) {
  const words = filter.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []
  return logs.filter((log) => {
    const level = log.level.toLowerCase()
    return (
      (!filter.from || log.time >= filter.from) &&
      (!filter.level ||
        filter.level === "all" ||
        (filter.level === "problems"
          ? /^(error|warn|warning|fatal|critical)$/.test(level)
          : filter.level === "warn"
            ? /^(warn|warning)$/.test(level)
            : level === filter.level)) &&
      (!filter.module || log.module === filter.module) &&
      (!filter.runId || log.runId === filter.runId) &&
      words.every((word) =>
        [log.event, log.module, log.runId, log.sessionId, log.traceId]
          .join(" ")
          .toLocaleLowerCase()
          .includes(word)
      )
    )
  })
}
