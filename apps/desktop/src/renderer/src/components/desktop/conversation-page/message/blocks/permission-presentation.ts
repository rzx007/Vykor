import type { DesktopPermissionRequest } from "@shared/session-types"

const developerActionLabels: Record<string, string> = {
  inspect_dom: "DOM 结构",
  inspect_styles: "计算样式",
  start_diagnostics: "开始控制台与网络采集",
  read_diagnostics: "读取控制台与网络采集结果",
  stop_diagnostics: "停止采集",
}

/** Reads only a validated developer scope; malformed payloads render nothing extra. */
export function readDeveloperScope(
  permission: DesktopPermissionRequest
): { reason: string; action: string; label: string } | null {
  if (permission.toolName !== "BrowserDeveloper") return null
  const rawInput = permission.payload.input
  const action =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>).action
      : undefined
  if (typeof action !== "string" || !(action in developerActionLabels)) return null
  const rawReason = permission.payload.reason
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 600) : ""
  return { reason, action, label: developerActionLabels[action]! }
}

const approvalReviewLabels = {
  reviewing: "正在自动审查",
  approved: "已自动批准",
  ask_user: "需要你确认",
  denied: "已拒绝",
  timed_out: "审查超时，需要你确认",
} as const

export function readPermissionReview(
  permission: DesktopPermissionRequest
): { status: keyof typeof approvalReviewLabels; label: string; reason: string } | null {
  const review = permission.payload.approvalReview
  if (!review || typeof review !== "object" || Array.isArray(review)) return null
  const record = review as Record<string, unknown>
  if (typeof record.status !== "string" || !Object.hasOwn(approvalReviewLabels, record.status))
    return null
  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : {}
  const reason = typeof record.reason === "string" ? record.reason : result.reason
  const label =
    permission.status === "expired"
      ? "请求已失效"
      : permission.status === "denied"
        ? "已拒绝"
        : permission.status === "approved" && record.status !== "approved"
          ? "已批准"
          : approvalReviewLabels[record.status as keyof typeof approvalReviewLabels]
  return {
    status: record.status as keyof typeof approvalReviewLabels,
    label,
    reason: typeof reason === "string" ? reason.slice(0, 1000) : "",
  }
}

export function requiresPermissionReply(permission: DesktopPermissionRequest): boolean {
  if (permission.status !== "pending") return false
  const review = readPermissionReview(permission)
  return !review || review.status === "ask_user" || review.status === "timed_out"
}
