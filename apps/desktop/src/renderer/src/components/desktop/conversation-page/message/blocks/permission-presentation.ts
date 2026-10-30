import type { DesktopPermissionRequest } from "@shared/session-types"

const operationLabels: Record<string, string> = {
  Shell: "运行命令",
  Bash: "运行命令",
  Write: "写入文件",
  Edit: "修改文件",
  ApplyPatch: "应用文件补丁",
  Read: "读取文件",
  Browser: "操作浏览器",
  BrowserDeveloper: "检查网页",
  JobCancel: "停止任务",
}

const operationFields = [
  ["command", "命令"],
  ["workdir", "工作目录"],
  ["file_path", "文件路径"],
  ["path", "路径"],
  ["url", "网址"],
  ["target", "目标"],
  ["action", "操作"],
] as const

function boundedPermissionText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  const text = value.trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Summarizes supplied operation fields only; missing paths and scopes stay missing. */
export function readPermissionOperation(permission: DesktopPermissionRequest): {
  summary: string
  toolName: string
  reason: string
  fields: { key: string; label: string; value: string }[]
  details: string
  detailsTruncated: boolean
} {
  const rawInput = permission.payload.input
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  const fields = operationFields.flatMap(([key, label]) => {
    let rawValue = input[key]
    if (key === "target" && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const target = rawValue as Record<string, unknown>
      rawValue =
        typeof target.kind === "string" && typeof target.jobId === "string"
          ? `${target.kind}: ${target.jobId}`
          : undefined
    }
    const value = boundedPermissionText(rawValue, 600)
    return value ? [{ key, label, value }] : []
  })
  let details: string
  try {
    details = JSON.stringify(permission.payload, null, 2)
  } catch {
    details = "无法显示原始详情"
  }
  const toolName = boundedPermissionText(permission.toolName, 120)
  return {
    summary: Object.hasOwn(operationLabels, permission.toolName)
      ? operationLabels[permission.toolName]!
      : "运行工具",
    toolName,
    reason: boundedPermissionText(permission.payload.reason, 1000),
    fields,
    details: details.slice(0, 12000),
    detailsTruncated: details.length > 12000,
  }
}

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
  if (typeof action !== "string" || !Object.hasOwn(developerActionLabels, action)) return null
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
