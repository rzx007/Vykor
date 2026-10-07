import { app, dialog, Notification, shell } from "electron"
import { open, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { readDaemonRegistry } from "@vykor/server/daemon-host"
import { CURRENT_PROTOCOL_VERSION } from "@vykor/client"
import type { DiagnosticFilter, DiagnosticLog, DiagnosticReport, MaintenanceBackupResult, UsageFilter, UsagePrice, UsageReport, UsageSettings } from "../../../shared/maintenance-settings-types"
import { desktopSessionService } from "../session/session-service"
import { createDesktopDaemonAutoStartController } from "../daemon-autostart/daemon-autostart-service"
import { getDesktopPreferences } from "./desktop-preferences"
import { filterDiagnosticLogRecords } from "../../../shared/diagnostic-log-filter"

/** Export only explicit operational fields; arbitrary log/error payloads never cross this boundary. */
export function redactDiagnosticLog(value: unknown): DiagnosticLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const safe = (value: unknown) => typeof value === "string" && /^[\w.:@-]{1,180}$/.test(value) ? value : undefined
  const event = safe(input.event)
  if (!event) return null
  const time = typeof input.time === "number" ? input.time : typeof input.timestamp === "number" ? input.timestamp : Date.parse(String(input.timestamp ?? ""))
  return { time: Number.isFinite(time) ? time : 0, level: safe(input.level) ?? "unknown", module: safe(input.module) ?? event.split(".")[0]!, event,
    ...(safe(input.runId) ? { runId: safe(input.runId) } : {}), ...(safe(input.sessionId) ? { sessionId: safe(input.sessionId) } : {}),
    ...(safe(input.traceId) ? { traceId: safe(input.traceId) } : {}), ...(safe(input.status) ? { status: safe(input.status) } : Number.isInteger(input.status) && Number(input.status) >= 100 && Number(input.status) <= 599 ? { status: String(input.status) } : {}),
    ...(safe(input.requestId) ? { requestId: safe(input.requestId) } : {}), ...(safe(input.toolName) ? { toolName: safe(input.toolName) } : {}), ...(safe(input.method) ? { method: safe(input.method) } : {}),
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}), }
}
export function usageCsv(report: UsageReport): string {
  const columns = ["id", "time", "project", "provider", "model", "sessionId", "runId", "status", "completeness", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "cost", "currency", "costKind", "costSource", "priceAdoptedAt", "inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreationPerMillion", "subscription"]
  const cell = (value: unknown) => { const text = value === null || value === undefined ? "" : String(value); return `"${(/^\s*[=+\-@]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"` }
  return "\uFEFF" + [columns.map(cell).join(","), ...report.requests.map(row => [row.id, new Date(row.time).toISOString(), row.project, row.provider, row.model, row.sessionId, row.runId, row.status, row.completeness, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.cost?.amount, row.cost?.currency, row.cost?.kind, row.cost?.source, row.cost?.adoptedAt, row.cost?.price.inputPerMillion, row.cost?.price.outputPerMillion, row.cost?.price.cacheReadPerMillion, row.cost?.price.cacheCreationPerMillion, row.subscription ? "subscription" : "unknown"].map(cell).join(","))].join("\r\n")
}
export class MaintenanceSettingsService {
  private budgetTimer: ReturnType<typeof setInterval> | null = null
  private lastBudgetNotice = ""
  startBudgetMonitor() {
    if (this.budgetTimer) return
    this.budgetTimer = setInterval(() => { void this.checkBudget().catch(() => {}); void this.request("/maintenance/cleanup/policy/run", {}).catch(() => {}) }, 60_000)
    this.budgetTimer.unref()
  }
  private async checkBudget() {
    const settings = await this.request<UsageSettings>("/maintenance/usage/settings")
    if (!settings.budget.enabled) return
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0)
    const report = await this.usage({ from: start.getTime() })
    const budget = report.settings.budget
    if (!budget.enabled) return
    const tokens = report.totals.input + report.totals.output
    const exceeded = (budget.tokens !== null && tokens >= budget.tokens) || (budget.amount !== null && (report.totals.costs[budget.currency] ?? 0) >= budget.amount)
    const key = `${readDaemonRegistry()?.storePath}:${start.getTime()}:${JSON.stringify(budget)}`
    if (!exceeded || this.lastBudgetNotice === key) return
    this.lastBudgetNotice = key
    if (Notification.isSupported() && getDesktopPreferences().notificationMode !== "never") new Notification({ title: "Vykor 用量提醒", body: "本月已知用量或估算费用达到所设阈值。统计可能不完整；任务不会因此停止。", silent: true }).show()
  }
  cleanupPreview(input: { kind: "session" | "log"; olderThan: number }) { return this.request<import("@vykor/server").CleanupPreview>("/maintenance/cleanup/preview", input) }
  storagePolicy() { return this.request<import("@vykor/client").StorageRetentionPolicy>("/maintenance/cleanup/policy") }
  updateStoragePolicy(input: { enabled: boolean; days: number; expected: { enabled: boolean; days: number } }) { return this.request<import("@vykor/client").StorageRetentionPolicy>("/maintenance/cleanup/policy", input) }
  cleanupExecute(input: { previewId: string; ids: string[] }) { return this.request<import("@vykor/server").CleanupResult>("/maintenance/cleanup/execute", input) }
  cleanupAudits() { return this.request<{ audits: Record<string, unknown>[] }>("/maintenance/cleanup/audits") }
  diagnosticDetails() { return this.request<{ expiresAt: number | null }>("/maintenance/diagnostics/details") }
  updateDiagnosticDetails(minutes: number) { return this.request<{ expiresAt: number | null }>("/maintenance/diagnostics/details", { minutes }) }
  private diagnosisController: AbortController | null = null
  private diagnosisRequestId: string | null = null
  private lastDiagnostics: DiagnosticReport | null = null
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const registry = maintenanceRegistry()
    if (!registry) throw new Error("后台服务未连接；请使用重新连接。");
    const response = await fetch(`${registry.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${registry.token}`, "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(30_000) })
    if (!response.ok) { const error = await response.json().catch(() => null) as { error?: string } | null; throw new Error(error?.error ?? `后台请求失败 (${response.status})`) }
    return await response.json() as T
  }
  usage(filter: UsageFilter) { return this.request<UsageReport>("/maintenance/usage", filter) }
  price(price: Omit<UsagePrice, "adoptedAt">) { return this.request<UsageSettings>("/maintenance/usage/price", price) }
  async budget(budget: UsageSettings["budget"] & { expected?: UsageSettings["budget"] }) { const result = await this.request<UsageSettings>("/maintenance/usage/budget", budget); this.lastBudgetNotice = ""; void this.checkBudget().catch(() => {}); return result }
  storage() { return this.request<import("@vykor/server").StorageReport>("/maintenance/storage") }
  async openDirectory() { const registry = readDaemonRegistry(); if (!registry) throw new Error("后台服务未连接"); const error = await shell.openPath(dirname(registry.storePath)); if (error) throw new Error(error) }
  async chooseDirectory() { const choice = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return choice.canceled ? null : choice.filePaths[0] ?? null }
  backup(input: { destination: string; includeMemory: boolean; includeOutput: boolean }) { return this.request<MaintenanceBackupResult>("/maintenance/backup", input, AbortSignal.timeout(600_000)) }
  verifyBackup(source: string) { return this.request<MaintenanceBackupResult>("/maintenance/backup/verify", { source }) }
  restore(input: { source: string; target: string }) { return this.request<MaintenanceBackupResult>("/maintenance/backup/restore", input, AbortSignal.timeout(600_000)) }
  async switchData(directory: string) { await desktopSessionService.switchDataDirectory(directory, { stopActive: false, storePath: join(directory, "sessions.db") }) }
  async reconnect() { await desktopSessionService.refreshDaemonClient() }
  async restart() { await desktopSessionService.restartDaemon({ stopActive: false }) }
  cancelDiagnosis(input?: { requestId: string }) {
    const requestId = readDiagnosisRequestId(input)
    if (requestId && requestId !== this.diagnosisRequestId) return
    this.diagnosisController?.abort()
  }
  async diagnose(input?: { requestId: string }): Promise<DiagnosticReport> {
    const requestId = readDiagnosisRequestId(input)
    this.cancelDiagnosis()
    const controller = new AbortController(); this.diagnosisController = controller
    this.diagnosisRequestId = requestId
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), 15_000)
    let registry: ReturnType<typeof readDaemonRegistry>
    try { registry = maintenanceRegistry() } catch { registry = undefined }
    const report: DiagnosticReport = { checkedAt: Date.now(), desktopVersion: app.getVersion(), platform: process.platform, architecture: process.arch, target: registry?.url ?? null, checks: [], logs: [], missing: [] }
    const probes: Array<[string, string, string, (value: Record<string, unknown>) => string]> = [
      ["health", "后台服务与版本", "/health", value => { if (value.ok !== true) throw new Error("后台服务未就绪"); return `后台版本 ${String(value.version ?? "未知")}；活动 ${Number(value.activeRunCount ?? 0)}，排队 ${Number(value.queuedRunCount ?? 0)}` }],
      ["readiness", "后台准入与就绪", "/maintenance/readiness", value => { if (value.phase !== "ready" || value.accepting !== true) throw new Error("后台未就绪或已停止接收新任务"); return "后台已就绪，正在接受新任务。只读取实际状态。" }],
      ["protocol", "协议兼容性", "/capabilities", value => { const protocol = value.protocol as { version?: unknown } | undefined; if (protocol?.version !== CURRENT_PROTOCOL_VERSION) throw new Error("协议不兼容"); return `协议 ${String(protocol.version)}；后台版本 ${String(value.serverVersion ?? "未知")}` }],
      ["runtime", "任务与待批准操作", "/debug/runtime", value => { const counts = value.permissions as { byStatus?: { pending?: number } } | undefined; return `待批准 ${counts?.byStatus?.pending ?? 0}；运行计数 ${JSON.stringify(value.coordinator ?? {})}` }],
      ["storage", "数据目录可写性与剩余空间", "/maintenance/storage/health", value => { if (!value.writable) throw new Error("数据目录不可写"); return `可写；剩余 ${value.availableBytes === null ? "文件系统不支持查询" : `${Number(value.availableBytes)} 字节`}` }],
      ["auth", "模型认证配置", "/auth", value => { const auth = value.auth as { storedProviders?: string[]; codex?: { configured?: boolean; state?: string } } | undefined; return `供应商凭据 ${auth?.storedProviders?.length ?? 0} 项；Codex ${auth?.codex?.configured ? "已配置" : auth?.codex?.state ?? "未配置"}。只读配置状态，未调用模型。` }],
      ["mcp", "MCP 连接摘要", "/mcp/oauth/status", value => { const servers = value.servers as Array<{ runtimeStatus?: string }> | undefined; return `已配置 ${servers?.length ?? 0} 项；${(servers ?? []).map(server => String(server.runtimeStatus ?? "未知")).join("、") || "尚无连接"}。未建立新连接。` }],
    ]
    try {
      await Promise.all(probes.map(async ([id, name, path, describe]) => {
        try { const value = await this.request<Record<string, unknown>>(path, undefined, controller.signal);
          if (id === "readiness" && value.phase === "unknown") { report.checks.push({ id, name, status: "unsupported", detail: "后台未提供只读就绪状态；存活响应不能证明已能接收新任务。" }); report.missing.push(name); return }
          if (id === "readiness" && (value.phase !== "ready" || value.accepting !== true)) { report.checks.push({ id, name, status: "failed", detail: `后台实际阶段 ${String(value.phase)}，当前不接收新任务。请查看最近错误后再安全重启。` }); return }
          const auth = value.auth as { storedProviders?: string[]; codex?: { configured?: boolean } } | undefined;
          const mcp = value.servers as Array<{ runtimeStatus?: string }> | undefined;
          const warning = (id === "health" && value.version !== app.getVersion()) || (id === "auth" && !auth?.storedProviders?.length && auth?.codex?.configured !== true) || (id === "mcp" && mcp?.some(server => server.runtimeStatus === "error" || server.runtimeStatus === "unavailable"));
          report.checks.push({ id, name, status: warning ? "warning" : "success", detail: describe(value) }) }
        catch { const status = controller.signal.aborted ? (controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout" ? "timeout" : "cancelled") : "failed"; report.checks.push({ id, name, status, detail: status === "failed" ? (id === "protocol" ? "协议检查失败或协议不兼容；请对齐桌面和后台版本。" : "后台不可达、检查失败或返回内容不符合要求；重新连接后再检查。") : status === "timeout" ? "检查超过 15 秒" : "已取消检查" }); report.missing.push(name) }
      }))
      try {
        const environment = await this.request<{ kind: string; distribution?: string; checks: Array<{ name: string; status: "ok" | "warning" | "failed"; detail: string }> }>("/maintenance/environment", undefined, controller.signal)
        report.checks.push({ id: "environment", name: "实际默认执行环境", status: "success", detail: `${environment.kind}${environment.distribution ? ` / ${environment.distribution}` : ""}` })
        environment.checks.forEach((check, index) => report.checks.push({ id: `environment-${index}`, name: check.name, status: check.status === "ok" ? "success" : check.status, detail: check.detail }))
      } catch { report.checks.push({ id: "environment", name: "Shell 与 Git 环境", status: diagnosisFailureStatus(controller.signal), detail: "实际环境检查未完成；可在运行环境页重新检查。" }); report.missing.push("Shell 与 Git 环境") }
      try { const residency = await withDiagnosticCancellation(createDesktopDaemonAutoStartController().snapshot(), controller.signal); report.checks.push({ id: "residency", name: "系统常驻服务", status: "success", detail: residency.enabled ? "常驻已启用" : "常驻未启用" }) } catch { report.checks.push({ id: "residency", name: "系统常驻服务", status: diagnosisFailureStatus(controller.signal), detail: "未取得系统常驻服务状态" }) }
      try { const result = await this.request<{ logs: unknown[] }>("/maintenance/logs", undefined, controller.signal); report.logs = result.logs.map(redactDiagnosticLog).filter((log): log is DiagnosticLog => log !== null).reverse() } catch { report.missing.push("当前服务运行日志") }
      const fileLogs = await withDiagnosticCancellation(this.readLogs(controller.signal), controller.signal).catch(() => [])
      report.logs = [...report.logs, ...fileLogs].slice(0, 1000)
      try { report.activeWork = await this.request<NonNullable<DiagnosticReport["activeWork"]>>("/maintenance/restart-preview", undefined, controller.signal) } catch { report.missing.push("活动任务与终端清单") }
      try { const errors = await this.request<{ errors: unknown[] }>("/maintenance/errors", undefined, controller.signal); report.logs = [...errors.errors.map(redactDiagnosticLog).filter((log): log is DiagnosticLog => log !== null), ...report.logs].sort((a, b) => b.time - a.time).slice(0, 1000) } catch { report.missing.push("持久运行错误") }
      if (!report.logs.length) report.missing.push("磁盘结构化日志未提供或为空")
      if (this.diagnosisController === controller) this.lastDiagnostics = report
      return report
    } finally { clearTimeout(timeout); if (this.diagnosisController === controller) { this.diagnosisController = null; this.diagnosisRequestId = null } }
  }
  private async readLogs(signal: AbortSignal): Promise<DiagnosticLog[]> {
    if (signal.aborted) return []
    const storage = await this.request<{ logsDirectory: string }>("/maintenance/storage/health", undefined, signal).catch(() => null)
    const directory = storage?.logsDirectory
    if (!directory) return []
    const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const logs: DiagnosticLog[] = []
    for (const file of files.filter(file => file.isFile() && /\.(jsonl|log|ndjson)$/.test(file.name)).slice(-10)) {
      if (signal.aborted) break
      const handle = await open(join(directory, file.name), "r").catch(() => null)
      if (!handle) continue
      let content: string
      try { const stat = await handle.stat(); const length = Math.min(stat.size, 2 * 1024 * 1024); const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, Math.max(0, stat.size - length)); content = buffer.toString("utf8") } finally { await handle.close() }
      for (const line of content.split(/\r?\n/).slice(-1000)) try { const log = redactDiagnosticLog(JSON.parse(line)); if (log) logs.push(log) } catch { /* plain logs may contain content; exclude them */ }
    }
    return logs.sort((a, b) => b.time - a.time).slice(0, 1000)
  }
  async exportUsage(filter: UsageFilter, format: "csv" | "json") {
    if (!["csv", "json"].includes(format)) throw new Error("导出格式无效")
    const report = await this.usage(filter)
    return this.saveExport(`vykor-usage.${format}`, format === "csv" ? usageCsv(report) : JSON.stringify({ version: 1, filter, ...report }, null, 2))
  }
  async exportDiagnostics(filter: DiagnosticFilter, kind: "diagnostics" | "logs") {
    if (!["diagnostics", "logs"].includes(kind)) throw new Error("诊断导出类型无效")
    const report = this.lastDiagnostics ?? await this.diagnose()
    const details = await this.diagnosticDetails().catch(() => ({ expiresAt: null }))
    const logs = filterDiagnosticLogRecords(report.logs, filter).map(row => { if (details.expiresAt && details.expiresAt > Date.now()) return row; const { toolName: _tool, method: _method, requestId: _request, ...basic } = row; return basic })
    const { query: _query, ...exportFilter } = filter
    const checks = report.checks.map(check => ({ ...check, detail: check.detail.replace(/[A-Za-z]:[\\/][^\s，；]+/g, "<path>").replace(/(?:^|\s)\/[^\s，；]+/g, " <path>") }))
    return this.saveExport(`vykor-${kind}.json`, JSON.stringify(kind === "logs" ? { version: 1, filter: exportFilter, logs } : { version: 1, ...report, checks, target: report.target ? new URL(report.target).origin : null, logs, includes: ["版本与平台", "只读检查结果", "最多1000条脱敏运行日志"], excludes: ["消息", "源码", "用户指令", "凭据", "机密变量", "绝对路径"] }, null, 2))
  }
  private async saveExport(name: string, content: string) { const choice = await dialog.showSaveDialog({ defaultPath: name }); if (choice.canceled || !choice.filePath) return null; await writeFile(choice.filePath, content, { encoding: "utf-8", mode: 0o600 }); return choice.filePath }
}
export const desktopMaintenanceSettingsService = new MaintenanceSettingsService()
function withDiagnosticCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => { const aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true }); work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)) })
}
function maintenanceRegistry() { try { return readDaemonRegistry() } catch { throw new Error("后台注册记录无法读取；请重新连接或在诊断页检查服务状态。") } }
function readDiagnosisRequestId(input?: { requestId: string }): string | null {
  if (input === undefined) return null
  if (!input || typeof input.requestId !== "string" || !/^[\w-]{1,80}$/.test(input.requestId))
    throw new Error("检查标识无效。")
  return input.requestId
}
function diagnosisFailureStatus(signal: AbortSignal): "failed" | "timeout" | "cancelled" {
  return !signal.aborted ? "failed"
    : signal.reason instanceof Error && signal.reason.message === "timeout" ? "timeout" : "cancelled"
}
