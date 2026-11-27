import { processPatch } from "@pierre/diffs"
import {
  CircleStop,
  FileDiff,
  FilePenLine,
  FileText,
  Globe,
  Monitor,
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
  Browser: { summary: "操作浏览器", icon: Globe },
  Computer: { summary: "操作 Windows 应用", icon: Monitor },
  BrowserDeveloper: { summary: "检查网页", icon: Globe },
  JobCancel: { summary: "停止任务", icon: CircleStop },
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

interface OperationField {
  key: string
  label: string
  value: string
}

function patchFields(patch: unknown): OperationField[] {
  // Only summarize complete patches that fit within the inspectable request preview.
  if (typeof patch !== "string" || patch.length > 12000) return []
  try {
    const { files } = processPatch(patch, undefined, true)
    if (!files.length || files.some((file) => !file.name || !file.hunks.length)) return []
    // Git headers are normalized by the parser. Plain unified headers retain their a/ or b/ prefix.
    const hasGitHeaders = /^diff --git/m.test(patch)
    const paths = files.map((file) => hasGitHeaders ? file.name : file.name.replace(/^[ab]\//, ""))
    let additions = 0
    let deletions = 0
    for (const file of files) {
      for (const hunk of file.hunks) {
        additions += hunk.additionLines
        deletions += hunk.deletionLines
      }
    }
    return [
      {
        key: "patchPaths",
        label: "文件路径",
        value: boundedPermissionText(paths.join("\n"), 600),
      },
      { key: "patchStats", label: "预计变更", value: `+${additions}  −${deletions}` },
    ]
  } catch {
    return []
  }
}

/** Summarizes supplied operation fields only; missing paths and scopes stay missing. */
export function readPermissionOperation(permission: DesktopPermissionRequest): {
  summary: string
  icon: LucideIcon
  toolName: string
  reason: string
  fields: OperationField[]
  details: string
  detailsTruncated: boolean
} {
  const rawInput = permission.payload.input
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  const fields: OperationField[] = operationFields.flatMap(([key, label]) => {
    let rawValue = input[key]
    if (key === "target" && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const target = rawValue as Record<string, unknown>
      rawValue =
        typeof target.kind === "string" && typeof target.jobId === "string"
          ? `${target.kind}: ${target.jobId}`
          : undefined
    }
    const value =
      key === "command" && typeof rawValue === "string" && rawValue.trim()
        ? rawValue
        : boundedPermissionText(rawValue, 600)
    return value ? [{ key, label, value }] : []
  })
  if (permission.toolName === "ApplyPatch") fields.push(...patchFields(input.patch))
  let details: string
  try {
    details = JSON.stringify(permission.payload, null, 2)
  } catch {
    details = "无法显示原始详情"
  }
  const toolName = boundedPermissionText(permission.toolName, 120)
  return {
    ...(Object.hasOwn(operations, permission.toolName)
      ? operations[permission.toolName]!
      : { summary: "运行工具", icon: ShieldCheck }),
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
    reason: typeof reason === "string" ? reason.slice(0, 1000) : "",
  }
}

export function requiresPermissionReply(permission: DesktopPermissionRequest): boolean {
  if (permission.status !== "pending") return false
  const review = readPermissionReview(permission)
  return !review || review.status === "ask_user" || review.status === "timed_out"
}
