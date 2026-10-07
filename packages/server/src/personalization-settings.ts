import { isDeepStrictEqual } from "node:util";
import { mkdir } from "node:fs/promises";
import {
  getProjectConfigDir,
  getProjectSettingsFilePath,
  getProjectMemoryDir,
  loadSettings,
  loadProjectSettings,
  saveProjectSettings,
  updateSettings,
  withSettingsFileLock,
  SettingsConflictError,
  type MemoryConfig,
} from "@vykor/core";
import { discoverClaudeMdFiles } from "@vykor/prompts";
import {
  getDetachedProcessSupervisor,
  readLastConsolidatedAt,
} from "@vykor/services";

export interface PersonalizationMemoryPreferences {
  enabled: boolean;
  autoExtractEnabled: boolean;
  sessionMemoryEnabled: boolean;
  autoDreamEnabled: boolean;
  autoDreamMinHours: number;
  autoDreamMinSessions: number;
}
const preferenceKeys = [
  "enabled",
  "autoExtractEnabled",
  "sessionMemoryEnabled",
  "autoDreamEnabled",
  "autoDreamMinHours",
  "autoDreamMinSessions",
] as const;
export async function inspectPersonalizationSettings(
  input: { cwd?: string; userMemory?: MemoryConfig } = {},
) {
  const user = (await loadSettings()).memory;
  const project = input.cwd
    ? (await loadProjectSettings(input.cwd))?.memory
    : undefined;
  const effective = {
    ...user,
    ...input.userMemory,
    ...project,
  } as PersonalizationMemoryPreferences;
  const directory = input.cwd ? getProjectMemoryDir(input.cwd) : undefined;
  const latest = input.cwd
    ? getDetachedProcessSupervisor(input.cwd)
        .listExecutions()
        .find((task) => task.type === "dream")
    : undefined;
  return {
    effective,
    configured: input.cwd ? (project ?? null) : (user ?? null),
    sources: Object.fromEntries(
      preferenceKeys.map((key) => [
        key,
        project && Object.hasOwn(project, key) ? "当前项目" : "用户默认",
      ]),
    ),
    rules: input.cwd ? await discoverClaudeMdFiles(input.cwd) : [],
    consolidation: {
      lastConsolidatedAt: directory
        ? readLastConsolidatedAt(directory) * 1000 || null
        : null,
      status: latest?.status ?? "unknown",
      taskId: latest?.id,
      finishedAt: latest?.finishedAt,
      error:
        latest?.status === "failed"
          ? `整理失败${latest.exitCode !== undefined ? `（退出码 ${latest.exitCode}）` : ""}`
          : undefined,
    },
  };
}
export async function saveMemoryConfiguration(input: {
  cwd?: string;
  value: PersonalizationMemoryPreferences | null;
  expected: MemoryConfig | null;
}) {
  const value = input.value;
  if (
    value !== null &&
    (!value ||
      [
        value.enabled,
        value.autoExtractEnabled,
        value.sessionMemoryEnabled,
        value.autoDreamEnabled,
      ].some((item) => typeof item !== "boolean") ||
      !Number.isFinite(value.autoDreamMinHours) ||
      value.autoDreamMinHours <= 0 ||
      value.autoDreamMinHours > 87600 ||
      !Number.isInteger(value.autoDreamMinSessions) ||
      value.autoDreamMinSessions <= 0 ||
      value.autoDreamMinSessions > 100000)
  )
    throw new Error("记忆开关或整理门槛无效，请输入有效正数和会话数量。");
  if (!input.cwd && !value) throw new Error("用户默认记忆配置不能整体移除。");
  const preferences = value
    ? (Object.fromEntries(
        preferenceKeys.map((key) => [key, value[key]]),
      ) as unknown as PersonalizationMemoryPreferences)
    : null;
  if (input.cwd) {
    await mkdir(getProjectConfigDir(input.cwd), { recursive: true });
    await withSettingsFileLock(
      async () => {
        const project = (await loadProjectSettings(input.cwd)) ?? {};
        if (!isDeepStrictEqual(project.memory ?? null, input.expected))
          throw new SettingsConflictError("memory");
        if (preferences) project.memory = { ...project.memory, ...preferences };
        else delete project.memory;
        await saveProjectSettings(project, input.cwd);
      },
      { lockPath: `${getProjectSettingsFilePath(input.cwd)}.lock` },
    );
  } else {
    await updateSettings((latest) => {
      if (!isDeepStrictEqual(latest.memory ?? null, input.expected))
        throw new SettingsConflictError("memory");
      return { ...latest, memory: { ...latest.memory, ...preferences! } };
    });
  }
}
