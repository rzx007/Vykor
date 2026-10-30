import type { StorageRetentionPolicy } from "@vykor/domain-contracts/maintenance";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { access, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getDataDir, getLogsDir } from "@vykor/host-config";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionStore } from "@vykor/services";
import type { DaemonControlService } from "../control/daemon-control-service.js";
import {
  canonicalBackupPath,
  createApplicationBackup,
  restoreApplicationBackup,
  verifyApplicationBackup,
} from "../backup/application-backup.js";
import {
  maintenanceDirectories,
  scanStorage,
} from "./storage-settings.js";
import {
  readUsageReport,
  type UsageFilter,
  type UsagePrice,
  type UsageSettings,
} from "./usage-settings.js";
import { MaintenanceCleanupService } from "./cleanup-settings.js";
import type { SessionCommandService } from "../session/session-command-service.js";
import type { SettingsService } from "../settings-api.js";
import {
  checkRuntimeEnvironment,
  inspectRuntimeEnvironment,
} from "../../runtime/runtime-settings.js";
import type { AgentEnvironmentSettings } from "@vykor/host-config";
import type { DaemonTerminalService } from "../../terminal/daemon-terminal-service.js";
import { parsePortableSettings } from "../settings/settings-transfer.js";

import { ApplicationError } from "../../shared/application-error.js";
import { createMaintenancePolicyRepository } from "./maintenance-policy-repository.js";

export type MaintenanceApplicationContext = {
  store: SessionStore;
  control: DaemonControlService;
  commands?: SessionCommandService;
  terminals?: DaemonTerminalService;
  settings?: SettingsService;
  readiness?: () => { phase: string; accepting: boolean } | undefined;
  logs?: () => unknown[];
  closeApplication?: () => Promise<void>;
};
export function createMaintenanceApplicationService(
  context: MaintenanceApplicationContext,
) {
  const cleanup = context.commands
    ? new MaintenanceCleanupService(
        context.store,
        context.control,
        context.commands,
        context.terminals,
      )
    : null;
  let detailedUntil = 0;
  const { readPolicy, savePolicy, readSettings, saveSettings } =
    createMaintenancePolicyRepository(context.store.path ?? "");
  function assertReady() {
    const state = context.readiness?.();
    if (state && (state.phase !== "ready" || !state.accepting))
      throw new ApplicationError(
        409,
        "后台尚未就绪或已停止准入，拒绝维护写操作",
      );
  }
  function assertAvailable(write = false) {
    if (typeof context.store.path !== "string")
      throw new ApplicationError(501, "当前后台未提供持久存储维护。");
    if (write) assertReady();
  }
  async function restartPreview() {
    const sessions = context.store.sessions.list({ includeArchived: true });
    const active = (status: string) =>
      status === "pending" || status === "running" || status === "stopping";
    const runs = sessions
      .flatMap((session) => context.store.runs.listRuns(session.id))
      .filter((run) => active(run.status))
      .map((run) => ({
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
      }));
    const tasks = sessions
      .flatMap((session) => context.store.listSessionTasks(session.id))
      .filter((task) => active(task.status))
      .map((task) => ({
        id: task.id,
        sessionId: task.sessionId,
        status: task.status,
      }));
    const terminals = ((await context.terminals?.list()) ?? [])
      .filter((terminal) => active(terminal.status))
      .map((terminal) => ({ id: terminal.id, status: terminal.status }));
    return { runs, tasks, terminals };
  }

  return {
    requireWriteReady: assertReady,
    async getReadiness(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      return context.readiness?.() ?? { phase: "unknown", accepting: false };
    },
    async getStorageHealth(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        assertPath(context.store.path);
        const root = dirname(context.store.path);
        const writable = await access(root, constants.W_OK).then(
          () => true,
          () => false,
        );
        const space = await statfs(root).catch(() => null);
        return {
          writable,
          availableBytes: space ? space.bavail * space.bsize : null,
          logsDirectory: getLogsDir(),
        };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async getRestartPreview(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      return await restartPreview();
    },
    async prepareRestart(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      if (!context.closeApplication)
        throw new ApplicationError(501, "后台未提供安全重启接口");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        throw new ApplicationError(
          409,
          "仍有运行或尚未收尾的任务，不能准备重启",
        );
      try {
        const preview = await restartPreview();
        if (
          preview.runs.length ||
          preview.tasks.length ||
          preview.terminals.length
        )
          throw new ApplicationError(
            409,
            "任务、后台任务或终端尚未结束，请收尾后重试",
          );
        // closeApplication closes admission synchronously; its drain waits for this lease.
        const closing = context.closeApplication();
        lease.release();
        await closing;
        return { prepared: true };
      } catch (error) {
        throw maintenanceError(error);
      } finally {
        lease.release();
      }
    },
    async readPolicy(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        return readPolicy();
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async updatePolicy(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const input = request as {
          enabled: boolean;
          days: number;
          expected: {
            enabled: boolean;
            days: number;
          };
        };
        if (
          typeof input.enabled !== "boolean" ||
          !Number.isSafeInteger(input.days) ||
          input.days < 1 ||
          input.days > 36500
        )
          throw new Error("保留天数必须为 1–36500 的整数");
        const latest = readPolicy();
        if (
          !input.expected ||
          latest.enabled !== input.expected.enabled ||
          latest.days !== input.expected.days
        )
          throw new ApplicationError(409, "保留策略已被修改，请重新读取后保存");
        return savePolicy({
          ...latest,
          enabled: input.enabled,
          days: input.days,
        });
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async runPolicyCleanup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const policy = readPolicy();
        if (
          !policy.enabled ||
          !cleanup ||
          (policy.lastRunAt !== null && Date.now() - policy.lastRunAt < 3600000)
        )
          return { skipped: true };
        const preview = cleanup.preview({
          kind: "session",
          olderThan: Date.now() - policy.days * 86400000,
        });
        const result = preview.candidates.length
          ? await cleanup.execute({
              previewId: preview.id,
              ids: preview.candidates.map((candidate) => candidate.id),
            })
          : null;
        savePolicy({ ...readPolicy(), lastRunAt: Date.now() });
        return { skipped: false, result };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async readErrors(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      const errors: Array<{
        timestamp: number;
        category: string;
        sessionId: string;
        runId: string;
        level: "error" | "warn";
        event: string;
      }> = [];
      for (const session of context.store.sessions.list({
        includeArchived: true,
      }))
        for (const run of context.store.runs.listRuns(session.id)) {
          if (run.status !== "failed" && run.status !== "interrupted") continue;
          const kind = context.store.runs
            .listRunAttempts(run.id)
            .at(-1)?.errorKind;
          const category =
            kind &&
            ["network", "timeout", "rate_limit", "server"].includes(kind)
              ? "network"
              : kind === "authentication" || kind === "quota"
                ? "authentication"
                : kind === "environment"
                  ? "environment"
                  : kind === "data"
                    ? "data"
                    : "runtime";
          errors.push({
            timestamp: run.finishedAt ?? run.updatedAt,
            category,
            sessionId: session.id,
            runId: run.id,
            level: run.status === "failed" ? "error" : "warn",
            event: `${category}.run.${run.status}`,
          });
        }
      return {
        errors: errors.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100),
      };
    },
    async inspectEnvironment(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        const settings = await context.settings?.get();
        const activeDefault = settings?.runtimeEnvironmentActive as
          AgentEnvironmentSettings | undefined;
        const environment = await inspectRuntimeEnvironment({ activeDefault });
        const checks = await checkRuntimeEnvironment({
          cwd: dirname(context.store.path),
          config: environment.activeDefault,
          signal: signal,
        });
        return {
          kind: environment.activeDefault.kind,
          distribution: environment.activeDefault.distribution,
          checks,
        };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async previewCleanup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        if (!cleanup) throw new Error("未配置清理服务");
        return cleanup.preview(
          request as Parameters<typeof cleanup.preview>[0],
        );
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async runCleanup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        if (!cleanup) throw new Error("未配置清理服务");
        return await cleanup.execute(
          request as Parameters<typeof cleanup.execute>[0],
        );
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async readCleanupAudits(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      return { audits: cleanup?.audits() ?? [] };
    },
    async readDiagnosticDetails(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      return { expiresAt: detailedUntil > Date.now() ? detailedUntil : null };
    },
    async updateDiagnosticDetails(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const { minutes } = request as {
          minutes: number;
        };
        if (![0, 15, 30, 60].includes(minutes))
          throw new Error("详细运行信息时限无效");
        detailedUntil = minutes ? Date.now() + minutes * 60000 : 0;
        return { expiresAt: detailedUntil || null };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async readLogs(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      return {
        logs: (context.logs?.() ?? []).map((value) => {
          if (detailedUntil > Date.now()) return value;
          const row = value as Record<string, unknown>;
          const {
            toolName: _toolName,
            requestId: _requestId,
            method: _method,
            ...basic
          } = row;
          return basic;
        }),
        scope: "当前服务启动以来最多1000条",
      };
    },
    async readUsage(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        const filter = request as UsageFilter;
        for (const field of [filter.from, filter.to])
          if (field !== undefined && (!Number.isFinite(field) || field < 0))
            throw new Error("时间范围无效");
        if (
          filter.from !== undefined &&
          filter.to !== undefined &&
          filter.from >= filter.to
        )
          throw new Error("开始时间必须早于结束时间");
        return readUsageReport(context.store, filter, readSettings());
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async readUsageSettings(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        return readSettings();
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async addUsagePrice(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const input = request as Record<string, unknown>;
        for (const field of ["provider", "model", "currency", "source"])
          if (typeof input[field] !== "string" || !input[field].trim())
            throw new Error("供应商、模型、币种和价格来源不能为空");
        const price: UsagePrice = {
          provider: String(input.provider ?? ""),
          model: String(input.model ?? ""),
          currency: String(input.currency ?? ""),
          source: String(input.source ?? ""),
          adoptedAt: Date.now(),
          subscription: input.subscription === true,
          inputIncludesCache: input.inputIncludesCache !== false,
          inputPerMillion: input.inputPerMillion as number,
          outputPerMillion: input.outputPerMillion as number,
          cacheReadPerMillion: input.cacheReadPerMillion as number,
          cacheCreationPerMillion: input.cacheCreationPerMillion as number,
        };
        if (!/^[A-Za-z]{3}$/.test(price.currency))
          throw new Error("币种必须为三个字母代码，例如 USD、CNY");
        for (const field of [
          "inputPerMillion",
          "outputPerMillion",
          "cacheReadPerMillion",
          "cacheCreationPerMillion",
        ] as const)
          if (!Number.isFinite(price[field]) || price[field] < 0)
            throw new Error("单位价格必须是非负数字");
        const settings = readSettings();
        settings.prices.push({
          ...price,
          currency: price.currency.toUpperCase(),
          subscription: price.subscription === true,
          adoptedAt: Date.now(),
        });
        return saveSettings(settings);
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async updateUsageSettings(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const input = request as UsageSettings["budget"] & {
          expected?: UsageSettings["budget"];
        };
        const { expected, enabled, tokens, amount, currency } = input;
        const budget = { enabled, tokens, amount, currency };
        const latest = readSettings();
        if (
          expected &&
          JSON.stringify(latest.budget) !== JSON.stringify(expected)
        )
          throw new ApplicationError(
            409,
            "预算提醒已被其他窗口修改，请重新读取并核对后保存",
          );
        if (
          typeof budget.enabled !== "boolean" ||
          !/^[A-Z]{3}$/.test(budget.currency)
        )
          throw new Error("预算格式无效");
        for (const value of [budget.tokens, budget.amount])
          if (value !== null && (!Number.isFinite(value) || value <= 0))
            throw new Error("提醒阈值须为正数或留空");
        if (budget.enabled && budget.tokens === null && budget.amount === null)
          throw new Error("启用提醒前请至少设置一个阈值");
        return saveSettings({ ...latest, budget });
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async readStorage(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable();
      try {
        return scanStorage(context.store.path);
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async createBackup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        throw new ApplicationError(
          409,
          "当前任务尚未收尾；请停止任务后重试备份。未创建数据库副本。",
        );
      let staging: string | undefined;
      try {
        const activeTasks = context.store.sessions
          .list({ includeArchived: true })
          .flatMap((session) => context.store.listSessionTasks(session.id))
          .filter(
            (task) => task.status === "pending" || task.status === "running",
          );
        if (activeTasks.length)
          throw new Error(
            `尚有 ${activeTasks.length} 个后台任务未收尾，备份未开始`,
          );
        const input = request as {
          destination: string;
          includeMemory?: boolean;
          includeOutput?: boolean;
        };
        assertPath(context.store.path);
        assertPath(input.destination);
        const destination = canonicalBackupPath(input.destination);
        const root = canonicalBackupPath(dirname(context.store.path));
        if (inside(root, destination))
          throw new Error("备份位置不能位于当前数据目录中");
        const directories = maintenanceDirectories(context.store.path);
        staging = join(
          getDataDir(),
          "maintenance-backup-staging",
          randomUUID(),
        );
        mkdirSync(staging, { recursive: true });
        const settings = await context.settings?.get();
        const nonSecretSettings: {
          general: Record<string, unknown>;
          model: Record<string, unknown>;
          memory: Record<string, unknown>;
        } = { general: {}, model: {}, memory: {} };
        // Only known non-content, non-credential scalars enter the portable snapshot.
        for (const key of [
          "workStyle",
          "replyStyle",
          "showReasoning",
          "maxTurns",
          "autoReview",
        ])
          if (["string", "number", "boolean"].includes(typeof settings?.[key]))
            nonSecretSettings.general[key] = settings![key];
        for (const key of ["model", "provider", "effort"])
          if (typeof settings?.[key] === "string")
            nonSecretSettings.model[key] = settings[key];
        const review = settings?.autoReview as
          | {
              mode?: unknown;
            }
          | undefined;
        if (review?.mode === "off" || review?.mode === "risk_based")
          nonSecretSettings.general.autoReview = { mode: review.mode };
        const memory = settings?.memory as Record<string, unknown> | undefined;
        const memorySettings: Record<string, unknown> = {};
        for (const key of [
          "enabled",
          "sessionMemoryEnabled",
          "autoExtractEnabled",
          "autoDreamEnabled",
          "maxFiles",
          "maxEntrypointLines",
          "autoDreamMinHours",
          "autoDreamMinSessions",
        ])
          if (
            typeof memory?.[key] === "boolean" ||
            typeof memory?.[key] === "number"
          )
            memorySettings[key] = memory[key];
        if (Object.keys(memorySettings).length)
          nonSecretSettings.memory.memory = memorySettings;
        const portable = parsePortableSettings({
          version: 1,
          groups: nonSecretSettings,
        });
        writeFileSync(
          join(staging, "non-secret-settings.json"),
          JSON.stringify(portable, null, 2),
          { mode: 0o600 },
        );
        writeFileSync(
          join(staging, "usage-settings.json"),
          JSON.stringify(readSettings(), null, 2),
          { mode: 0o600 },
        );
        writeFileSync(
          join(staging, "storage-policy.json"),
          JSON.stringify(readPolicy(), null, 2),
          { mode: 0o600 },
        );
        if (
          input.includeMemory &&
          existsSync(join(getDataDir(), "session-memory"))
        )
          cpSync(
            join(getDataDir(), "session-memory"),
            join(staging, "session-memory"),
            { recursive: true },
          );
        const manifest = await createApplicationBackup({
          store: context.store,
          destination,
          sources: {
            artifacts: staging,
            attachments: directories.attachments,
            ...(input.includeMemory ? { memory: directories.memory } : {}),
            ...(input.includeOutput
              ? { executionOutput: directories.executionOutput }
              : {}),
          },
        });
        verifyApplicationBackup(destination);
        const bytes = backupBytes(destination);
        const history = join(getDataDir(), "backup-audits");
        mkdirSync(history, { recursive: true });
        writeFileSync(
          join(history, `${manifest.backupId}.json`),
          JSON.stringify(
            {
              version: 1,
              path: destination,
              createdAt: manifest.createdAt,
              bytes,
              manifest,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        return {
          path: destination,
          manifest,
          totalBytes: bytes,
          excludes: ["供应商及渠道凭据", "用户指令与机密设置"],
          settingsExcluded: false,
        };
      } catch (error) {
        throw maintenanceError(error);
      } finally {
        try {
          if (staging) rmSync(staging, { recursive: true, force: true });
        } finally {
          lease.release();
        }
      }
    },
    async verifyBackup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const { source } = request as {
          source: string;
        };
        assertPath(source);
        const manifest = verifyApplicationBackup(source);
        return {
          path: resolve(source),
          manifest,
          totalBytes: backupBytes(source),
        };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
    async restoreBackup(request: unknown = {}, signal?: AbortSignal) {
      assertAvailable(true);
      try {
        const { source, target } = request as {
          source: string;
          target: string;
        };
        assertPath(source);
        assertPath(target);
        assertPath(context.store.path);
        const root = canonicalBackupPath(target);
        if (
          inside(canonicalBackupPath(dirname(context.store.path)), root) ||
          inside(root, canonicalBackupPath(dirname(context.store.path)))
        )
          throw new Error("恢复目标必须与活动数据目录完全分离");
        if (existsSync(root) && readdirSync(root).length)
          throw new Error("只允许恢复到空目录");
        verifyApplicationBackup(source);
        const space = statfsSync(existsSync(root) ? root : dirname(root));
        if (space.bavail * space.bsize < backupBytes(source))
          throw new Error("恢复目标剩余空间不足，请选择更大磁盘");
        mkdirSync(root, { recursive: true });
        const manifest = restoreApplicationBackup({
          source,
          storePath: join(root, "sessions.db"),
          destinations: {
            attachments: join(root, "attachments"),
            memory: join(root, "memory"),
            executionOutput: join(root, "tasks"),
            artifacts: join(root, "artifacts"),
          },
        });
        if (existsSync(join(root, "artifacts", "session-memory")))
          renameSync(
            join(root, "artifacts", "session-memory"),
            join(root, "session-memory"),
          );
        if (existsSync(join(root, "artifacts", "usage-settings.json")))
          cpSync(
            join(root, "artifacts", "usage-settings.json"),
            join(root, "usage-settings.json"),
          );
        if (existsSync(join(root, "artifacts", "storage-policy.json"))) {
          const recovered = JSON.parse(
            readFileSync(
              join(root, "artifacts", "storage-policy.json"),
              "utf-8",
            ),
          ) as StorageRetentionPolicy;
          writeFileSync(
            join(root, "storage-policy.json"),
            JSON.stringify({ ...recovered, enabled: false, lastRunAt: null }),
            { mode: 0o600 },
          );
        }
        const settingsSnapshotPath = join(
          root,
          "artifacts",
          "non-secret-settings.json",
        );
        return {
          path: root,
          manifest,
          ...(existsSync(settingsSnapshotPath) ? { settingsSnapshotPath } : {}),
        };
      } catch (error) {
        throw maintenanceError(error);
      }
    },
  };
}
export type MaintenanceApplicationService = ReturnType<
  typeof createMaintenanceApplicationService
>;
function maintenanceError(error: unknown): ApplicationError {
  return error instanceof ApplicationError
    ? error
    : new ApplicationError(
        400,
        error instanceof Error ? error.message : String(error),
      );
}
function assertPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !isAbsolute(value) ||
    value.includes("\0")
  )
    throw new Error("请选择绝对目录路径");
}
function inside(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function backupBytes(root: string): number {
  return readdirSync(root, { withFileTypes: true }).reduce(
    (bytes, entry) =>
      bytes +
      (entry.isDirectory()
        ? backupBytes(join(root, entry.name))
        : entry.isFile()
          ? statSync(join(root, entry.name)).size
          : 0),
    0,
  );
}
