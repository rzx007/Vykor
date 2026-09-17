import type { DesktopScheduledRun, DesktopScheduledTask } from "@shared/schedule-types"

import type { ScheduledFilter } from "./types"

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

export function filterTabLabel(value: ScheduledFilter): string {
  return { all: "全部", active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

export function statusLabel(value: DesktopScheduledTask["status"]): string {
  return { active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

export function nextScheduleStatus(task: DesktopScheduledTask): "active" | "paused" {
  return task.status === "active" ? "paused" : "active"
}

export function recurrenceShortLabel(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return formatTime(Date.parse(task.recurrence))

  const rule = parseRecurrenceRule(task)
  const time = formatRuleTime(rule)

  if (rule.FREQ === "DAILY") return `每天 ${time}`
  if (rule.FREQ === "WEEKLY") return `每周 ${time}`
  if (rule.FREQ === "MONTHLY") return `每月 ${rule.BYMONTHDAY ?? ""} 日 ${time}`.trim()
  return task.recurrence.replace(/^RRULE:/, "")
}

export function recurrenceFrequency(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return "一次"
  const rule = parseRecurrenceRule(task)
  return (
    {
      DAILY: "每天",
      WEEKLY: "每周",
      MONTHLY: "每月",
    }[rule.FREQ ?? ""] ?? "自定义规则"
  )
}

export function recurrenceTime(task: DesktopScheduledTask): string | null {
  if (task.recurrenceFormat === "once") return formatTime(Date.parse(task.recurrence))
  return formatRuleTime(parseRecurrenceRule(task))
}

export function formatNextRunLabel(value: number): string {
  return `下次运行 ${formatTime(value)}`
}

export function projectLabel(task: DesktopScheduledTask): string {
  const path = task.projectPaths[0]
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "不在项目中工作"
}

export function formatRunAge(createdAt: number): string {
  const days = Math.floor((Date.now() - createdAt) / 86_400_000)
  if (days <= 0) return "今天"
  return `${days} 天`
}

export function runHistoryState(
  run: Pick<DesktopScheduledRun, "sessionId" | "status">
): "openable" | "pending" | "unavailable" {
  if (run.sessionId) return "openable"
  if (run.status === "queued" || run.status === "running") return "pending"
  return "unavailable"
}

function parseRecurrenceRule(task: DesktopScheduledTask): Record<string, string> {
  return Object.fromEntries(
    task.recurrence
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=", 2))
  )
}

function formatRuleTime(rule: Record<string, string>): string {
  const hour = Number(rule.BYHOUR ?? 0)
  const minute = Number(rule.BYMINUTE ?? 0)
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function formatTime(value: number): string {
  return dateTimeFormatter.format(value)
}
