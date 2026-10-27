import type { DesktopWorkflowRun, DesktopWorkflowTask } from "@shared/workflow-types"
import type { DesktopSessionPart } from "@shared/session-types"
import { toolOutputText } from "../../conversation-page/message/models/message-content"

export function workflowToolRunId(output: unknown): string | undefined {
  try {
    const raw = toolOutputText(output)
    if (!raw) return undefined
    const payload = raw.match(
      /<workflow-notification>\s*<payload>([\s\S]*?)<\/payload>\s*<\/workflow-notification>/
    )?.[1]
    const envelope =
      payload
        ?.replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&") ?? raw
    const value = JSON.parse(envelope)
    if (
      value.kind === "job" &&
      value.jobKind === "workflow" &&
      value.action === "created" &&
      typeof value.jobId === "string" && value.jobId.length > 0
    )
      return value.jobId
    if (typeof value.runId === "string" && Array.isArray(value.tasks)) return value.runId
  } catch {
    /* A tool preview or free-form worker response is not a run identity. */
  }
  return undefined
}

export const workflowTitle = (run: DesktopWorkflowRun): string =>
  run.tasks.length ? `编排 · ${run.tasks.length} 项任务` : "编排"

/** These are references reported by the worker, not independently verified deliverables. */
export function workflowOutputFiles(task: DesktopWorkflowTask): string[] {
  const paths = new Map<string, string>()
  for (const match of (task.result ?? "").matchAll(/(?<!`)`([^`\r\n]+)`(?!`)/g)) {
    const path = match[1]
    if (
      !/^(?:[a-z]:[\\/]|\/(?!\/))[^<>|?*\r\n]+\.[a-z0-9]{1,12}$/i.test(path) ||
      path.split(/[\\/]/).some((segment) => segment === "..." || segment === "..")
    )
      continue
    const key = /^[a-z]:/i.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path
    if (!paths.has(key)) paths.set(key, path)
  }
  return [...paths.values()]
}

export function workflowProgress(run: DesktopWorkflowRun): string {
  if (!run.detailsAvailable) return "任务详情暂不可用"
  const counts = workflowCounts(run)
  return [
    `${counts.completed}/${counts.total} 项任务完成`,
    counts.running ? `${counts.running} 项运行中` : "",
    counts.pending ? `${counts.pending} 项等待` : "",
    counts.failed ? `失败 ${counts.failed}` : "",
    counts.skipped ? `跳过 ${counts.skipped}` : "",
    counts.killed ? `停止 ${counts.killed}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export function workflowCounts(run: DesktopWorkflowRun) {
  return {
    total: run.tasks.length,
    completed: run.tasks.filter((task) => task.status === "completed").length,
    failed: run.tasks.filter((task) => task.status === "failed").length,
    skipped: run.tasks.filter((task) => task.status === "skipped").length,
    killed: run.tasks.filter((task) => task.status === "killed").length,
    running: run.tasks.filter((task) => task.status === "running").length,
    pending: run.tasks.filter((task) => task.status === "pending").length,
  }
}

export function workflowStatus(run: DesktopWorkflowRun): string {
  if (run.status === "killed" && run.tasks.some((task) => task.cleanupUnconfirmed))
    return "已请求停止 · 有任务未确认停止"
  return {
    running: "运行中",
    stopping: "正在停止",
    completed: "已完成",
    failed: "执行失败",
    killed: "已停止",
  }[run.status]
}

export function workflowTaskLabel(task: DesktopWorkflowTask): string {
  if (task.cleanupUnconfirmed) return "未确认停止"
  if (task.status === "running" && task.needsInput) return "等待处理"
  if (task.status === "pending") {
    if (task.waitReason === "write_conflict") return "等待修改范围"
    if (task.waitReason === "dependency") return "等待上游"
    return "等待调度"
  }
  if (task.timedOut) return "执行超时"
  return {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    killed: "已停止",
    skipped: "已跳过",
    unknown: "状态待确认",
  }[task.status]
}

export function workflowWaitText(
  task: DesktopWorkflowTask,
  run: DesktopWorkflowRun
): string | undefined {
  const names = task.waitingForTaskIds
    .map((id) => run.tasks.find((candidate) => candidate.id === id)?.title ?? id)
    .join("、")
  if (task.waitReason === "write_conflict") return `与「${names}」的修改范围重叠，正在等待。`
  if (task.waitReason === "dependency") return `等待「${names}」完成。`
  if (task.waitReason === "capacity") return "依赖条件已满足，等待执行名额或调度。"
  return undefined
}

export function workflowImpact(tasks: DesktopWorkflowTask[], taskId: string): Set<string> {
  const affected = new Set<string>()
  const queue = [taskId]
  for (let index = 0; index < queue.length; index++) {
    for (const task of tasks) {
      if (
        task.id !== taskId &&
        task.dependencies.includes(queue[index]) &&
        !affected.has(task.id)
      ) {
        affected.add(task.id)
        queue.push(task.id)
      }
    }
  }
  return affected
}

export const graphNodeWidth = 224
export const graphNodeHeight = 104

/** Topological columns depend only on the plan, never on changing run statuses. */
export function layoutWorkflow(tasks: DesktopWorkflowTask[]) {
  const ids = new Set(tasks.map((task) => task.id))
  const columns = new Map<string, number>()
  const remaining = [...tasks]
  while (remaining.length) {
    const ready = remaining.filter((task) =>
      task.dependencies.every((id) => !ids.has(id) || columns.has(id))
    )
    if (!ready.length) {
      const last = Math.max(0, ...columns.values()) + 1
      remaining.forEach((task) => columns.set(task.id, last))
      break
    }
    for (const task of ready) {
      columns.set(
        task.id,
        Math.max(-1, ...task.dependencies.map((id) => columns.get(id) ?? -1)) + 1
      )
      remaining.splice(remaining.indexOf(task), 1)
    }
  }
  const rows = new Map<number, number>()
  const nodes = tasks.map((task) => {
    const column = columns.get(task.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return {
      id: task.id,
      column,
      x: 16 + column * (graphNodeWidth + 48),
      y: 16 + row * (graphNodeHeight + 24),
    }
  })
  return {
    nodes,
    width: 32 + (Math.max(0, ...columns.values()) + 1) * (graphNodeWidth + 48) - 48,
    height: 32 + Math.max(1, ...rows.values()) * (graphNodeHeight + 24) - 24,
  }
}

export function workflowRepairDraft(run: DesktopWorkflowRun, task?: DesktopWorkflowTask): string {
  const failures = task
    ? [task]
    : run.tasks.filter((candidate) => candidate.status === "failed" || candidate.cleanupUnconfirmed)
  return `请检查编排 ${run.id} 的问题并提出处理方案。\n${run.needsReconciliation ? `需要检查和合并改动：\n${run.reconciliationIssues.join("\n")}\n` : ""}${failures.map((candidate) => `任务：${candidate.title}（${candidate.id}）\n状态：${workflowTaskLabel(candidate)}\n原因：${candidate.error ?? candidate.summary ?? "请读取任务结果确认"}`).join("\n\n")}\n请先核对已完成工作和现有文件改动，避免重复执行有副作用的步骤。`
}

export function findWorkflowSourcePart(
  parts: DesktopSessionPart[],
  sessionId: string,
  runId: string
): DesktopSessionPart | undefined {
  return parts.find((part) => {
    if (
      part.sessionId !== sessionId ||
      part.type !== "tool" ||
      part.toolName !== "Workflow" ||
      !["run", "resume"].includes(String(part.input?.action ?? "run"))
    )
      return false
    const result = part.toolUseId
      ? parts.find(
          (candidate) =>
            candidate.sessionId === sessionId &&
            candidate.type === "tool_result" &&
            candidate.toolUseId === part.toolUseId
        )
      : undefined
    return (
      part.metadata.workflowRunId === runId ||
      result?.metadata.workflowRunId === runId ||
      workflowToolRunId(result?.output ?? part.output) === runId ||
      part.input?.runId === runId
    )
  })
}
