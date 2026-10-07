import { loadSettings, parsePermissionSettings, parseAgentEnvironmentSettings, SettingsConflictError, updateSettings, type Settings } from "@vykor/core";
import { isDeepStrictEqual } from "node:util";

export const SETTINGS_TRANSFER_GROUPS = {
  general: ["workStyle", "showReasoning", "maxTurns", "autoReview"],
  permission: ["permission"], memory: ["memory", "systemPrompt"],
  model: ["model", "provider", "effort", "modelDisabled"], environment: ["agentEnvironment"],
} as const;
export interface PortableSettings { version: 1; groups: Partial<Record<keyof typeof SETTINGS_TRANSFER_GROUPS, Record<string, unknown>>> }

export function parsePortableSettings(value: unknown): PortableSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设置文件必须是 JSON 对象。");
  const file = value as PortableSettings;
  if (file.version !== 1 || !file.groups || typeof file.groups !== "object" || Array.isArray(file.groups) || Object.keys(file).some(key => key !== "version" && key !== "groups")) throw new Error("设置导入格式或版本不受支持。");
  for (const [category, raw] of Object.entries(file.groups)) {
    if (!Object.hasOwn(SETTINGS_TRANSFER_GROUPS, category)) throw new Error("设置文件包含未知分类。");
    const fields = SETTINGS_TRANSFER_GROUPS[category as keyof typeof SETTINGS_TRANSFER_GROUPS] as readonly string[] | undefined;
    if (!fields || !raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) throw new Error("设置文件包含未知分类或字段。");
    if (raw.permission !== undefined) parsePermissionSettings(raw.permission);
    if (raw.agentEnvironment !== undefined) {
      const environment = parseAgentEnvironmentSettings(raw.agentEnvironment);
      if (environment.env !== undefined || environment.secretEnv !== undefined) throw new Error("普通配置导入不接受环境变量或机密引用。");
    }
    if (raw.workStyle !== undefined && raw.workStyle !== "practical" && raw.workStyle !== "efficient") throw new Error("工作风格无效。");
    if (raw.showReasoning !== undefined && typeof raw.showReasoning !== "boolean") throw new Error("思考展示开关无效。");
    if (raw.modelDisabled !== undefined && typeof raw.modelDisabled !== "boolean") throw new Error("默认模型开关无效。");
    if (raw.maxTurns !== undefined && (!Number.isInteger(raw.maxTurns) || (raw.maxTurns as number) < 1 || (raw.maxTurns as number) > 1000)) throw new Error("任务轮数上限必须是 1–1000 的整数。");
    if (raw.autoReview !== undefined) {
      const review = raw.autoReview as Record<string, unknown>;
      if (!review || typeof review !== "object" || Object.keys(review).some(key => key !== "mode") || (review.mode !== "off" && review.mode !== "risk_based")) throw new Error("完成后检查设置无效。");
    }
    for (const key of ["model", "provider", "effort", "systemPrompt"]) if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`${key} 必须是文本。`);
    for (const key of ["model", "provider"]) if (typeof raw[key] === "string" && !raw[key].trim()) throw new Error(`${key} 不能为空。`);
    if (raw.memory !== undefined) {
      const memory = raw.memory as Record<string, unknown>;
      const flags = ["enabled", "sessionMemoryEnabled", "autoExtractEnabled", "autoDreamEnabled"];
      const numbers = ["maxFiles", "maxEntrypointLines", "autoDreamMinHours", "autoDreamMinSessions"];
      if (!memory || typeof memory !== "object" || Array.isArray(memory) || Object.keys(memory).some(key => ![...flags, ...numbers].includes(key))) throw new Error("记忆设置包含未知字段。");
      for (const [key, setting] of Object.entries(memory)) if (flags.includes(key) ? typeof setting !== "boolean" : !Number.isFinite(setting) || (setting as number) <= 0) throw new Error("记忆开关或门槛无效。");
    }
  }
  return structuredClone(file);
}

export async function exportPortableSettings(): Promise<PortableSettings> {
  const settings = await loadSettings(undefined, { includeEnvironment: false });
  const groups: PortableSettings["groups"] = {};
  for (const [category, fields] of Object.entries(SETTINGS_TRANSFER_GROUPS)) {
    const group: Record<string, unknown> = {};
    for (const field of fields) {
      const value = settings[field as keyof Settings];
      if (value === undefined) continue;
      group[field] = field === "agentEnvironment" ? { kind: settings.agentEnvironment!.kind,
        ...(settings.agentEnvironment!.distribution ? { distribution: settings.agentEnvironment!.distribution } : {}),
        ...(settings.agentEnvironment!.shell ? { shell: settings.agentEnvironment!.shell } : {}) } : structuredClone(value);
    }
    groups[category as keyof typeof groups] = group;
  }
  return { version: 1, groups };
}

export async function importPortableSettings(value: unknown, selected: string[], expected: PortableSettings,
  expectedValidation?: Partial<Pick<Settings, "sandbox" | "customProviders">>): Promise<Settings> {
  const file = parsePortableSettings(value);
  if (!selected.length || selected.some(category => !Object.hasOwn(file.groups, category))) throw new Error("请选择文件中存在的设置分类。");
  return await updateSettings(current => {
    for (const field of ["sandbox", "customProviders"] as const) {
      if (expectedValidation && Object.hasOwn(expectedValidation, field) && !isDeepStrictEqual(current[field], expectedValidation[field])) throw new SettingsConflictError(field);
    }
    for (const category of selected) {
      const target = file.groups[category as keyof typeof file.groups]!;
      const baseline = expected.groups[category as keyof typeof expected.groups];
      for (const key of Object.keys(target)) {
        let present: unknown = current[key as keyof Settings];
        if (key === "agentEnvironment" && current.agentEnvironment) {
          const { env: _env, secretEnv: _secretEnv, ...ordinary } = current.agentEnvironment;
          present = ordinary;
        }
        if (!isDeepStrictEqual(present, baseline?.[key])) throw new SettingsConflictError(key);
      }
    }
    const patch = Object.assign({}, ...selected.map(category => file.groups[category as keyof typeof file.groups])) as Partial<Settings>;
    return { ...current, ...patch,
      modelDisabled: patch.modelDisabled ?? (patch.model ? false : current.modelDisabled),
      permission: patch.permission ? { ...current.permission, ...patch.permission } : current.permission,
      memory: patch.memory ? { ...current.memory, ...patch.memory } : current.memory,
      agentEnvironment: patch.agentEnvironment ? { ...current.agentEnvironment, ...patch.agentEnvironment } : current.agentEnvironment,
    };
  }, { includeEnvironment: false });
}
