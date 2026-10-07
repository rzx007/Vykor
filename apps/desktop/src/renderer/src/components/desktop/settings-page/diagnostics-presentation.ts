import type { DiagnosticCheck } from "@shared/maintenance-settings-types"

export function diagnosisSummary(checks: DiagnosticCheck[]) {
  const passed = checks.filter((item) => item.status === "success").length
  const failed = checks.filter((item) => item.status === "failed").length
  const warnings = checks.filter((item) => item.status === "warning").length
  const incomplete = checks.length - passed - failed - warnings
  const tone = failed
    ? "error"
    : warnings
      ? "warning"
      : !checks.length || incomplete
        ? "neutral"
        : "success"
  const title = failed
    ? "有检查项需要处理"
    : warnings
      ? "有检查项需要关注"
      : !checks.length || incomplete
        ? "检查未完成，状态尚未确认"
        : "本次服务检查通过"
  return { passed, failed, warnings, incomplete, tone, title } as const
}
