import {
  CircleStop,
  FileDiff,
  FilePenLine,
  FileText,
  Globe,
  Monitor,
  Search,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"
import type { DesktopPermissionRequest } from "@shared/session-types"

const operations: Record<string, { summary: string; icon: LucideIcon }> = {
  Shell: { summary: "运行命令", icon: SquareTerminal },
  Bash: { summary: "运行命令", icon: SquareTerminal },
  Write: { summary: "写入文件", icon: FilePenLine },
  Edit: { summary: "修改文件", icon: FilePenLine },
  ApplyPatch: { summary: "应用文件补丁", icon: FileDiff },
  Read: { summary: "读取文件", icon: FileText },
  WebSearch: { summary: "搜索网页", icon: Search },
  ToolSearch: { summary: "搜索工具", icon: Search },
  Browser: { summary: "操作浏览器", icon: Globe },
  Computer: { summary: "操作 Windows 应用", icon: Monitor },
  BrowserDeveloper: { summary: "检查网页", icon: Globe },
  JobCancel: { summary: "停止任务", icon: CircleStop },
}

export function readPermissionOperation(permission: DesktopPermissionRequest): {
  summary: string
  icon: LucideIcon
  toolName: string
  details: string
} {
  const toolName = permission.toolName
  const operation = Object.hasOwn(operations, toolName)
    ? operations[toolName]!
    : { summary: "运行工具", icon: ShieldCheck }
  let details: string
  try {
    details = JSON.stringify(permission.payload, null, 2)
  } catch {
    details = "无法显示原始详情"
  }
  return { ...operation, toolName, details }
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
): { action: string; label: string } | null {
  if (permission.toolName !== "BrowserDeveloper") return null
  const rawInput = permission.payload.input
  const action =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>).action
      : undefined
  if (typeof action !== "string" || !Object.hasOwn(developerActionLabels, action)) return null
  return { action, label: developerActionLabels[action]! }
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
    reason:
      typeof reason === "string" && reason !== "No matching rule found"
        ? reason.trim().slice(0, 1000)
        : "",
  }
}

export function requiresPermissionReply(permission: DesktopPermissionRequest): boolean {
  if (permission.status !== "pending") return false
  const review = readPermissionReview(permission)
  return !review || review.status === "ask_user" || review.status === "timed_out"
}
