import { Hono } from "hono";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getDataDir, getLogsDir } from "@vykor/core";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionStore } from "@vykor/services";
import type { DaemonControlService } from "../../application/control/daemon-control-service.js";
import { canonicalBackupPath, createApplicationBackup, restoreApplicationBackup, verifyApplicationBackup } from "../../application/backup/application-backup.js";
import { maintenanceDirectories, scanStorage } from "../../application/maintenance/storage-settings.js";
import { defaultUsageSettings, readUsageReport, type UsageFilter, type UsagePrice, type UsageSettings } from "../../application/maintenance/usage-settings.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";
import { MaintenanceCleanupService } from "../../application/maintenance/cleanup-settings.js";
import type { SessionCommandService } from "../../application/session/session-command-service.js";
import type { SettingsService } from "../../application/settings-api.js";
import { checkRuntimeEnvironment, inspectRuntimeEnvironment } from "../../runtime/runtime-settings.js";
import type { AgentEnvironmentSettings } from "@vykor/core";
import type { StorageRetentionPolicy } from "@vykor/protocol";
import type { DaemonTerminalService } from "../../terminal/daemon-terminal-service.js";
import { parsePortableSettings } from "../../settings-transfer.js";

export function createMaintenanceRoutes(context: { store: SessionStore; control: DaemonControlService; commands?: SessionCommandService; terminals?: DaemonTerminalService; settings?: SettingsService; readiness?: () => { phase: string; accepting: boolean } | undefined; logs?: () => unknown[] }) {
  const cleanup = context.commands ? new MaintenanceCleanupService(context.store, context.control, context.commands, context.terminals) : null;
  let detailedUntil = 0;
  const policyPath = join(dirname(context.store.path), "storage-policy.json");
  function readPolicy(): StorageRetentionPolicy {
    if (!existsSync(policyPath)) return { version: 1, enabled: false, days: 90, lastRunAt: null };
    const policy = JSON.parse(readFileSync(policyPath, "utf-8")) as StorageRetentionPolicy;
    if (policy.version !== 1 || typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.days) || policy.days < 1 || policy.days > 36500) throw new Error("存储保留策略格式无效");
    return policy;
  }
  function savePolicy(policy: StorageRetentionPolicy) { writeFileSync(`${policyPath}.tmp`, JSON.stringify(policy), { mode: 0o600 }); renameSync(`${policyPath}.tmp`, policyPath); return policy; }
  const configPath = join(dirname(context.store.path), "usage-settings.json");
  function readSettings(): UsageSettings {
    if (!existsSync(configPath)) return structuredClone(defaultUsageSettings);
    const value = JSON.parse(readFileSync(configPath, "utf-8")) as UsageSettings;
    if (value.version !== 1 || !Array.isArray(value.prices)) throw new Error("用量配置格式不兼容");
    if (Object.keys(value).some(key => !["version", "prices", "budget"].includes(key)) || !value.budget || typeof value.budget.enabled !== "boolean" || !/^[A-Z]{3}$/.test(value.budget.currency)) throw new Error("用量配置包含无效字段");
    for (const threshold of [value.budget.tokens, value.budget.amount]) if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0)) throw new Error("已保存预算阈值无效");
    for (const price of value.prices) {
      if (!price || typeof price.subscription !== "boolean" || !Number.isFinite(price.adoptedAt) || price.adoptedAt < 0) throw new Error("已保存价格依据无效");
      for (const key of ["provider", "model", "currency", "source"] as const) if (typeof price[key] !== "string" || !price[key].trim()) throw new Error("已保存价格来源无效");
      for (const key of ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreationPerMillion"] as const) if (!Number.isFinite(price[key]) || price[key] < 0) throw new Error("已保存单位价格无效");
    }
    return value;
  }
  function saveSettings(value: UsageSettings) {
    const temporary = `${configPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, configPath);
    return value;
  }
  return new Hono()
    .use("/maintenance/*", async (c, next) => { const state = context.readiness?.(); if (c.req.method !== "GET" && c.req.path !== "/maintenance/usage" && state && (state.phase !== "ready" || !state.accepting)) return errorResponse(409, "后台尚未就绪或已停止准入，拒绝维护写操作"); await next(); })
    .get("/maintenance/readiness", () => jsonResponse(context.readiness?.() ?? { phase: "unknown", accepting: false }))
    .get("/maintenance/storage/health", async () => { try {
      assertPath(context.store.path); const root = dirname(context.store.path);
      const writable = await access(root, constants.W_OK).then(() => true, () => false);
      const space = await statfs(root).catch(() => null);
      return jsonResponse({ writable, availableBytes: space ? space.bavail * space.bsize : null, logsDirectory: getLogsDir() });
    } catch (error) { return fail(error); } })
    .get("/maintenance/restart-preview", async () => {
      const sessions = context.store.sessions.list({ includeArchived: true });
      const active = (status: string) => status === "pending" || status === "running" || status === "stopping";
      const runs = sessions.flatMap(session => context.store.runs.listRuns(session.id)).filter(run => active(run.status)).map(run => ({ id: run.id, sessionId: run.sessionId, status: run.status }));
      const tasks = sessions.flatMap(session => context.store.listSessionTasks(session.id)).filter(task => active(task.status)).map(task => ({ id: task.id, sessionId: task.sessionId, status: task.status }));
      const terminals = (await context.terminals?.list() ?? []).filter(terminal => active(terminal.status)).map(terminal => ({ id: terminal.id, status: terminal.status }));
      return jsonResponse({ runs, tasks, terminals });
    })
    .get("/maintenance/cleanup/policy", () => { try { return jsonResponse(readPolicy()); } catch (error) { return fail(error); } })
    .post("/maintenance/cleanup/policy", async c => { try {
      const input = await readJson(c) as { enabled: boolean; days: number; expected: { enabled: boolean; days: number } };
      if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.days) || input.days < 1 || input.days > 36500) throw new Error("保留天数必须为 1–36500 的整数");
      const latest = readPolicy();
      if (!input.expected || latest.enabled !== input.expected.enabled || latest.days !== input.expected.days) return errorResponse(409, "保留策略已被修改，请重新读取后保存");
      return jsonResponse(savePolicy({ ...latest, enabled: input.enabled, days: input.days }));
    } catch (error) { return fail(error); } })
    .post("/maintenance/cleanup/policy/run", async () => { try {
      const policy = readPolicy();
      if (!policy.enabled || !cleanup || (policy.lastRunAt !== null && Date.now() - policy.lastRunAt < 3600000)) return jsonResponse({ skipped: true });
      const preview = cleanup.preview({ kind: "session", olderThan: Date.now() - policy.days * 86400000 });
      const result = preview.candidates.length ? await cleanup.execute({ previewId: preview.id, ids: preview.candidates.map(candidate => candidate.id) }) : null;
      savePolicy({ ...readPolicy(), lastRunAt: Date.now() });
      return jsonResponse({ skipped: false, result });
    } catch (error) { return fail(error); } })
    .get("/maintenance/errors", () => {
      const errors: Array<{ timestamp: number; category: string; sessionId: string; runId: string; level: "error" | "warn"; event: string }> = [];
      for (const session of context.store.sessions.list({ includeArchived: true })) for (const run of context.store.runs.listRuns(session.id)) {
        if (run.status !== "failed" && run.status !== "interrupted") continue;
        const kind = context.store.runs.listRunAttempts(run.id).at(-1)?.errorKind;
        const category = kind && ["network", "timeout", "rate_limit", "server"].includes(kind) ? "network" : kind === "authentication" || kind === "quota" ? "authentication" : kind === "environment" ? "environment" : kind === "data" ? "data" : "runtime";
        errors.push({ timestamp: run.finishedAt ?? run.updatedAt, category, sessionId: session.id, runId: run.id, level: run.status === "failed" ? "error" : "warn", event: `${category}.run.${run.status}` });
      }
      return jsonResponse({ errors: errors.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100) });
    })
    .get("/maintenance/environment", async c => { try {
      const settings = await context.settings?.get();
      const activeDefault = settings?.runtimeEnvironmentActive as AgentEnvironmentSettings | undefined;
      const environment = await inspectRuntimeEnvironment({ activeDefault });
      const checks = await checkRuntimeEnvironment({ cwd: dirname(context.store.path), config: environment.activeDefault, signal: c.req.raw.signal });
      return jsonResponse({ kind: environment.activeDefault.kind, distribution: environment.activeDefault.distribution, checks });
    } catch (error) { return fail(error); } })
    .post("/maintenance/cleanup/preview", async c => { try { if (!cleanup) throw new Error("未配置清理服务"); return jsonResponse(cleanup.preview(await readJson(c) as Parameters<typeof cleanup.preview>[0])); } catch (error) { return fail(error); } })
    .post("/maintenance/cleanup/execute", async c => { try { if (!cleanup) throw new Error("未配置清理服务"); return jsonResponse(await cleanup.execute(await readJson(c) as Parameters<typeof cleanup.execute>[0])); } catch (error) { return fail(error); } })
    .get("/maintenance/cleanup/audits", () => jsonResponse({ audits: cleanup?.audits() ?? [] }))
    .get("/maintenance/diagnostics/details", () => jsonResponse({ expiresAt: detailedUntil > Date.now() ? detailedUntil : null }))
    .post("/maintenance/diagnostics/details", async c => { try { const { minutes } = await readJson(c) as { minutes: number }; if (![0, 15, 30, 60].includes(minutes)) throw new Error("详细运行信息时限无效"); detailedUntil = minutes ? Date.now() + minutes * 60_000 : 0; return jsonResponse({ expiresAt: detailedUntil || null }); } catch (error) { return fail(error); } })
    .get("/maintenance/logs", () => jsonResponse({ logs: (context.logs?.() ?? []).map(value => { if (detailedUntil > Date.now()) return value; const row = value as Record<string, unknown>; const { toolName: _toolName, requestId: _requestId, method: _method, ...basic } = row; return basic; }), scope: "当前服务启动以来最多1000条" }))
    .post("/maintenance/usage", async c => {
      try {
        const filter = await readJson(c) as UsageFilter;
        for (const field of [filter.from, filter.to]) if (field !== undefined && (!Number.isFinite(field) || field < 0)) throw new Error("时间范围无效");
        if (filter.from !== undefined && filter.to !== undefined && filter.from >= filter.to) throw new Error("开始时间必须早于结束时间");
        return jsonResponse(readUsageReport(context.store, filter, readSettings()));
      } catch (error) { return fail(error); }
    })
    .get("/maintenance/usage/settings", () => { try { return jsonResponse(readSettings()); } catch (error) { return fail(error); } })
    .post("/maintenance/usage/price", async c => {
      try {
        const input = await readJson(c);
        for (const field of ["provider", "model", "currency", "source"]) if (typeof input[field] !== "string" || !input[field].trim()) throw new Error("供应商、模型、币种和价格来源不能为空");
        const price: UsagePrice = { provider: String(input.provider ?? ""), model: String(input.model ?? ""), currency: String(input.currency ?? ""), source: String(input.source ?? ""), adoptedAt: Date.now(), subscription: input.subscription === true,
          inputIncludesCache: input.inputIncludesCache !== false, inputPerMillion: input.inputPerMillion as number, outputPerMillion: input.outputPerMillion as number, cacheReadPerMillion: input.cacheReadPerMillion as number, cacheCreationPerMillion: input.cacheCreationPerMillion as number };
        if (!/^[A-Za-z]{3}$/.test(price.currency)) throw new Error("币种必须为三个字母代码，例如 USD、CNY");
        for (const field of ["provider", "model", "currency", "source"] as const) if (typeof price[field] !== "string" || !price[field].trim()) throw new Error("供应商、模型、币种和价格来源不能为空");
        for (const field of ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreationPerMillion"] as const) if (!Number.isFinite(price[field]) || price[field] < 0) throw new Error("单位价格必须是非负数字");
        const settings = readSettings();
        settings.prices.push({ ...price, currency: price.currency.toUpperCase(), subscription: price.subscription === true, adoptedAt: Date.now() });
        return jsonResponse(saveSettings(settings));
      } catch (error) { return fail(error); }
    })
    .post("/maintenance/usage/budget", async c => {
      try {
        const input = await readJson(c) as UsageSettings["budget"] & { expected?: UsageSettings["budget"] };
        const { expected, enabled, tokens, amount, currency } = input;
        const budget = { enabled, tokens, amount, currency };
        const latest = readSettings();
        if (expected && JSON.stringify(latest.budget) !== JSON.stringify(expected)) return errorResponse(409, "预算提醒已被其他窗口修改，请重新读取并核对后保存");
        if (typeof budget.enabled !== "boolean" || !/^[A-Z]{3}$/.test(budget.currency)) throw new Error("预算格式无效");
        for (const value of [budget.tokens, budget.amount]) if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error("提醒阈值须为正数或留空");
        if (budget.enabled && budget.tokens === null && budget.amount === null) throw new Error("启用提醒前请至少设置一个阈值");
        return jsonResponse(saveSettings({ ...latest, budget }));
      } catch (error) { return fail(error); }
    })
    .get("/maintenance/storage", () => { try { return jsonResponse(scanStorage(context.store.path)); } catch (error) { return fail(error); } })
    .post("/maintenance/backup", async c => {
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return errorResponse(409, "当前任务尚未收尾；请停止任务后重试备份。未创建数据库副本。");
      let staging: string | undefined;
      try {
        const activeTasks = context.store.sessions.list({ includeArchived: true }).flatMap(session => context.store.listSessionTasks(session.id)).filter(task => task.status === "pending" || task.status === "running");
        if (activeTasks.length) throw new Error(`尚有 ${activeTasks.length} 个后台任务未收尾，备份未开始`);
        const input = await readJson(c) as { destination: string; includeMemory?: boolean; includeOutput?: boolean };
        assertPath(context.store.path);
        assertPath(input.destination);
        const destination = canonicalBackupPath(input.destination);
        const root = canonicalBackupPath(dirname(context.store.path));
        if (inside(root, destination)) throw new Error("备份位置不能位于当前数据目录中");
        const directories = maintenanceDirectories(context.store.path);
        staging = join(getDataDir(), "maintenance-backup-staging", randomUUID());
        mkdirSync(staging, { recursive: true });
        const settings = await context.settings?.get();
        const nonSecretSettings: { general: Record<string, unknown>; model: Record<string, unknown>; memory: Record<string, unknown> } = { general: {}, model: {}, memory: {} };
        // Only known non-content, non-credential scalars enter the portable snapshot.
        for (const key of ["workStyle", "showReasoning", "maxTurns", "autoReview"])
          if (["string", "number", "boolean"].includes(typeof settings?.[key])) nonSecretSettings.general[key] = settings![key];
        for (const key of ["model", "provider", "effort"])
          if (typeof settings?.[key] === "string") nonSecretSettings.model[key] = settings[key];
        const review = settings?.autoReview as { mode?: unknown } | undefined;
        if (review?.mode === "off" || review?.mode === "risk_based") nonSecretSettings.general.autoReview = { mode: review.mode };
        const memory = settings?.memory as Record<string, unknown> | undefined;
        const memorySettings: Record<string, unknown> = {};
        for (const key of ["enabled", "sessionMemoryEnabled", "autoExtractEnabled", "autoDreamEnabled", "maxFiles", "maxEntrypointLines", "autoDreamMinHours", "autoDreamMinSessions"])
          if (typeof memory?.[key] === "boolean" || typeof memory?.[key] === "number") memorySettings[key] = memory[key];
        if (Object.keys(memorySettings).length) nonSecretSettings.memory.memory = memorySettings;
        const portable = parsePortableSettings({ version: 1, groups: nonSecretSettings });
        writeFileSync(join(staging, "non-secret-settings.json"), JSON.stringify(portable, null, 2), { mode: 0o600 });
        writeFileSync(join(staging, "usage-settings.json"), JSON.stringify(readSettings(), null, 2), { mode: 0o600 });
        writeFileSync(join(staging, "storage-policy.json"), JSON.stringify(readPolicy(), null, 2), { mode: 0o600 });
        if (input.includeMemory && existsSync(join(getDataDir(), "session-memory"))) cpSync(join(getDataDir(), "session-memory"), join(staging, "session-memory"), { recursive: true });
        const manifest = await createApplicationBackup({ store: context.store, destination, sources: {
          artifacts: staging,
          attachments: directories.attachments,
          ...(input.includeMemory ? { memory: directories.memory } : {}),
          ...(input.includeOutput ? { executionOutput: directories.executionOutput } : {}),
        } });
        verifyApplicationBackup(destination);
        const bytes = backupBytes(destination);
        const history = join(getDataDir(), "backup-audits"); mkdirSync(history, { recursive: true });
        writeFileSync(join(history, `${manifest.backupId}.json`), JSON.stringify({ version: 1, path: destination, createdAt: manifest.createdAt, bytes, manifest }, null, 2), { mode: 0o600 });
        return jsonResponse({ path: destination, manifest, totalBytes: bytes, excludes: ["供应商及渠道凭据", "用户指令与机密设置"], settingsExcluded: false });
      } catch (error) { return fail(error); } finally { try { if (staging) rmSync(staging, { recursive: true, force: true }); } finally { lease.release(); } }
    })
    .post("/maintenance/backup/verify", async c => { try {
      const { source } = await readJson(c) as { source: string }; assertPath(source);
      const manifest = verifyApplicationBackup(source);
      return jsonResponse({ path: resolve(source), manifest, totalBytes: backupBytes(source) });
    } catch (error) { return fail(error); } })
    .post("/maintenance/backup/restore", async c => { try {
      const { source, target } = await readJson(c) as { source: string; target: string }; assertPath(source); assertPath(target);
      assertPath(context.store.path);
      const root = canonicalBackupPath(target);
      if (inside(canonicalBackupPath(dirname(context.store.path)), root) || inside(root, canonicalBackupPath(dirname(context.store.path)))) throw new Error("恢复目标必须与活动数据目录完全分离");
      if (existsSync(root) && readdirSync(root).length) throw new Error("只允许恢复到空目录");
      verifyApplicationBackup(source);
      const space = statfsSync(existsSync(root) ? root : dirname(root));
      if (space.bavail * space.bsize < backupBytes(source)) throw new Error("恢复目标剩余空间不足，请选择更大磁盘");
      mkdirSync(root, { recursive: true });
      const manifest = restoreApplicationBackup({ source, storePath: join(root, "sessions.db"), destinations: { attachments: join(root, "attachments"), memory: join(root, "memory"), executionOutput: join(root, "tasks"), artifacts: join(root, "artifacts") } });
      if (existsSync(join(root, "artifacts", "session-memory"))) renameSync(join(root, "artifacts", "session-memory"), join(root, "session-memory"));
      if (existsSync(join(root, "artifacts", "usage-settings.json"))) cpSync(join(root, "artifacts", "usage-settings.json"), join(root, "usage-settings.json"));
      if (existsSync(join(root, "artifacts", "storage-policy.json"))) { const recovered = JSON.parse(readFileSync(join(root, "artifacts", "storage-policy.json"), "utf-8")) as StorageRetentionPolicy; writeFileSync(join(root, "storage-policy.json"), JSON.stringify({ ...recovered, enabled: false, lastRunAt: null }), { mode: 0o600 }); }
      const settingsSnapshotPath = join(root, "artifacts", "non-secret-settings.json");
      return jsonResponse({ path: root, manifest, ...(existsSync(settingsSnapshotPath) ? { settingsSnapshotPath } : {}) });
    } catch (error) { return fail(error); } });
}
function assertPath(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || !isAbsolute(value) || value.includes("\0")) throw new Error("请选择绝对目录路径"); }
function inside(root: string, target: string) { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); }
function fail(error: unknown) { return errorResponse(400, error instanceof Error ? error.message : String(error)); }
function backupBytes(root: string): number { return readdirSync(root, { withFileTypes: true }).reduce((bytes, entry) => bytes + (entry.isDirectory() ? backupBytes(join(root, entry.name)) : entry.isFile() ? statSync(join(root, entry.name)).size : 0), 0); }
